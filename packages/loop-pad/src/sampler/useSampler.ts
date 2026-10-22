// useSampler — the sampler's controller: routes MIDI events to the audio
// engine and 16-slot project state, handles delete-note timing, CC->mixer
// routing to the last-triggered slot, count-in transport interception, and
// project switching/persistence. UI components only read the returned state
// and call the handful of setting/project handlers; all MIDI-driven state
// changes happen on refs so the audio/MIDI callbacks never see stale data.

import { useEffect, useMemo, useRef, useState } from 'react';
import { SamplerEngine } from '../audio/samplerEngine';
import { MidiEngine, type MidiDeviceRef, type MidiEvent } from '../midi/midiEngine';
import {
  computePeaks, makeDefaultProject, makeDefaultSlot, SLOT_COUNT,
  type BankIndex, type Project, type Slot,
} from './model';
import {
  clearAllProjects, loadProject, saveProject, downloadAllProjects,
  restoreProjectsFromZip, restoreSingleProject, PROJECT_COUNT,
} from './session';
import { loadSettings, saveSettings, type SamplerSettings } from './settings';
import {
  findRememberedDevice, getRememberedDeviceNumber,
  rememberDeviceName, rememberDeviceNumber,
} from '../util/deviceMemory';

const DELETE_WINDOW_MS = 500;
const AUTO_SAVE_DEBOUNCE_MS = 800;
const UI_TICK_MS = 50;
const TEMPO_SMOOTHING_WINDOW = 24; // one quarter note of inter-pulse intervals
const MIN_BPM_STABLE_CLOCKS = 48; // two beats, matching Tape's startup filter
const CLOCK_STALE_FALLBACK_MS = 1000;
const CLOCK_STALE_MULTIPLIER = 4; // no-pulse gap, in multiples of the recent avg interval
const TRANSPORT_ECHO_WINDOW_MS = 250;
const MAX_RECORDING_TAIL_MS = 5000;
const MAX_RECORDING_LATENCY_MS = 5000;
const NOTE_FLASH_MS = 150;
const BANK_A: BankIndex = 0;
const BANK_B: BankIndex = 1;

interface SlotAddress {
  bank: BankIndex;
  slot: number;
}

function engineSlot({ bank, slot }: SlotAddress): number {
  return bank * SLOT_COUNT + slot;
}

function calcBpm(times: number[]): number | null {
  if (times.length < 2) return null;
  let totalMs = 0;
  for (let i = 1; i < times.length; i++) totalMs += times[i]! - times[i - 1]!;
  const avgMs = totalMs / (times.length - 1);
  return 60000 / (avgMs * 24);
}

export function useSampler() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [audioInputs, setAudioInputs] = useState<MediaDeviceInfo[]>([]);
  const [selectedAudioInputId, setSelectedAudioInputId] = useState<string | null>(null);
  const [audioInputChannelCount, setAudioInputChannelCount] = useState(1);
  const [selectedAudioInputChannelPairStart, setSelectedAudioInputChannelPairStart] = useState(0);
  const [audioOutputs, setAudioOutputs] = useState<MediaDeviceInfo[]>([]);
  const [selectedAudioOutputId, setSelectedAudioOutputId] = useState<string>('');
  const [audioOutputChannelCount, setAudioOutputChannelCount] = useState(2);
  const [selectedAudioOutputChannelPairStart, setSelectedAudioOutputChannelPairStart] = useState(0);
  const [midiInputs, setMidiInputs] = useState<MidiDeviceRef[]>([]);
  const [selectedMidiInputId, setSelectedMidiInputId] = useState<string | null>(null);
  const [midiOutputs, setMidiOutputs] = useState<MidiDeviceRef[]>([]);
  const [selectedMidiOutputId, setSelectedMidiOutputId] = useState<string | null>(null);

  const [settings, setSettings] = useState<SamplerSettings>(() => loadSettings());
  const [projectIndex, setProjectIndex] = useState(1);
  const [project, setProject] = useState<Project>(() => makeDefaultProject());
  const [bpm, setBpm] = useState<number | null>(null);
  const [clockRunning, setClockRunning] = useState(false);
  const [countInCounting, setCountInCounting] = useState(false);
  const [restoreStatus, setRestoreStatus] = useState('');
  const [playbackProgress, setPlaybackProgress] = useState<(number | null)[]>(() => Array(SLOT_COUNT).fill(null));
  const [tick, setTick] = useState(0);
  const [inputLevelAnalysers, setInputLevelAnalysers] = useState<{ left: AnalyserNode; right: AnalyserNode } | null>(null);
  const [masterLevelAnalysers, setMasterLevelAnalysers] = useState<{ left: AnalyserNode; right: AnalyserNode } | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<SlotAddress | null>(null);
  const [activeBank, setActiveBank] = useState<BankIndex>(BANK_A);
  const [flashingSlots, setFlashingSlots] = useState<Set<number>>(() => new Set());

  const activeBankRef = useRef<BankIndex>(BANK_A);
  const engineRef = useRef<SamplerEngine | null>(null);
  const midiRef = useRef<MidiEngine | null>(null);
  const projectRef = useRef<Project>(project);
  const projectIndexRef = useRef(1);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const selectedSlotRef = useRef<SlotAddress | null>(null);
  const deletedSlotsRef = useRef<Map<number, Slot>>(new Map());
  const lastSampleEventRef = useRef<{ address: SlotAddress; time: number } | null>(null);
  const lastDeleteEventTimeRef = useRef<number | null>(null);
  const standaloneDeleteTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clockTimesRef = useRef<number[]>([]);
  const clockRunningRef = useRef(false);
  const clocksSinceStartRef = useRef(0);
  const countInStateRef = useRef<'idle' | 'counting' | 'awaiting-restart'>('idle');
  const countInClockCountRef = useRef(0);
  const countInTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const expectedTransportEchoRef = useRef<{ type: 'start' | 'stop'; expiresAt: number } | null>(null);
  const sentTransportEventsRef = useRef<('start' | 'stop')[]>([]);
  const initPromiseRef = useRef<Promise<void> | null>(null);
  const initErrorRef = useRef<string | null>(null);
  const autoSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const playbackStartRef = useRef<Map<number, { startedAt: number; durationMs: number; startProgress: number }>>(new Map());
  const recordingTailTimeoutRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());
  const recordingWasEmptyRef = useRef<Map<number, boolean>>(new Map());
  const recordingModeRef = useRef<Map<number, 'one-shot' | 'take'>>(new Map());
  const noteFlashTimeoutRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => () => {
    for (const timeout of noteFlashTimeoutRef.current.values()) clearTimeout(timeout);
  }, []);

  function slotAt(address: SlotAddress): Slot {
    return projectRef.current.banks[address.bank][address.slot]!;
  }

  function refreshProject(): void {
    setProject({ banks: [ [...projectRef.current.banks[0]], [...projectRef.current.banks[1]] ] });
  }

  function scheduleAutoSave(): void {
    if (autoSaveTimeoutRef.current) clearTimeout(autoSaveTimeoutRef.current);
    autoSaveTimeoutRef.current = setTimeout(() => {
      void saveProject(projectIndexRef.current, projectRef.current);
    }, AUTO_SAVE_DEBOUNCE_MS);
  }

  function cancelRecordingTail(address: SlotAddress): void {
    const id = engineSlot(address);
    const timeout = recordingTailTimeoutRef.current.get(id);
    if (timeout) clearTimeout(timeout);
    recordingTailTimeoutRef.current.delete(id);
  }

  function selectSlot(address: SlotAddress | null): void {
    const previous = selectedSlotRef.current;
    if (previous?.bank === address?.bank && previous?.slot === address?.slot) return;
    if (previous && address) {
      const previousSlot = slotAt(previous);
      const previousId = engineSlot(previous);
      const isUnfinalizedTake = previousSlot.takePending
        || (previousSlot.state === 'recording' && recordingModeRef.current.get(previousId) === 'take');
      if (isUnfinalizedTake) discardSlot(previous);
    }
    selectedSlotRef.current = address;
    setSelectedSlot(address);
    if (address) setActiveBankValue(address.bank);
  }

  function setActiveBankValue(bank: BankIndex): void {
    activeBankRef.current = bank;
    setActiveBank(bank);
  }

  function clearSelection(): void {
    selectSlot(null);
  }

  function flashSlot(address: SlotAddress): void {
    const id = engineSlot(address);
    const existingTimeout = noteFlashTimeoutRef.current.get(id);
    if (existingTimeout) clearTimeout(existingTimeout);
    setFlashingSlots((slots) => new Set(slots).add(id));
    noteFlashTimeoutRef.current.set(id, setTimeout(() => {
      noteFlashTimeoutRef.current.delete(id);
      setFlashingSlots((slots) => {
        const next = new Set(slots);
        next.delete(id);
        return next;
      });
    }, NOTE_FLASH_MS));
  }

  function discardSlot(address: SlotAddress): void {
    const engine = engineRef.current!;
    const id = engineSlot(address);
    const current = slotAt(address);
    if (current.state === 'recording') {
      cancelRecordingTail(address);
      engine.cancelRecording(id);
    }
    recordingModeRef.current.delete(id);
    recordingWasEmptyRef.current.delete(id);
    engine.clearSlotBuffer(id);
    projectRef.current.banks[address.bank][address.slot] = makeDefaultSlot();
    deletedSlotsRef.current.delete(id);
    scheduleAutoSave();
  }

  function deleteSlot(address: SlotAddress): void {
    const engine = engineRef.current!;
    const id = engineSlot(address);
    const current = slotAt(address);
    const deleted = deletedSlotsRef.current.get(id);
    if (current.state === 'recording') {
      cancelRecordingTail(address);
      engine.cancelRecording(id);
    }
    engine.clearSlotBuffer(id);
    if (deleted) {
      projectRef.current.banks[address.bank][address.slot] = deleted;
      if (deleted.samples) engine.loadSlotBuffer(id, deleted.samples);
      deletedSlotsRef.current.delete(id);
      selectSlot(address);
      scheduleAutoSave();
      return;
    }
    if (current.samples) deletedSlotsRef.current.set(id, { ...current, state: 'stopped' });
    projectRef.current.banks[address.bank][address.slot] = makeDefaultSlot();
    if (selectedSlotRef.current?.bank === address.bank && selectedSlotRef.current.slot === address.slot) clearSelection();
    scheduleAutoSave();
  }

  function checkDeleteAgainstSampleEvent(deleteTime: number): boolean {
    const last = lastSampleEventRef.current;
    if (!last || deleteTime - last.time > DELETE_WINDOW_MS) return false;
    deleteSlot(last.address);
    return true;
  }

  function clearDeleteGesture(): void {
    if (standaloneDeleteTimeoutRef.current) clearTimeout(standaloneDeleteTimeoutRef.current);
    standaloneDeleteTimeoutRef.current = null;
    lastDeleteEventTimeRef.current = null;
    lastSampleEventRef.current = null;
  }

  function stopPlayback(): void {
    const engine = engineRef.current!;
    for (const bank of [BANK_A, BANK_B] as const) {
      for (let slot = 0; slot < SLOT_COUNT; slot++) {
        const address = { bank, slot };
        const current = slotAt(address);
        engine.stop(engineSlot(address));
        if (current.state === 'playing') current.state = 'stopped';
      }
    }
    playbackStartRef.current.clear();
  }

  function stopInProgressRecordings(): void {
    const engine = engineRef.current!;
    for (const bank of [BANK_A, BANK_B] as const) {
      for (let slot = 0; slot < SLOT_COUNT; slot++) {
        const address = { bank, slot };
        const current = slotAt(address);
        if (current.state !== 'recording') continue;
        const id = engineSlot(address);
        cancelRecordingTail(address);
        if (recordingWasEmptyRef.current.get(id)) {
          void engine.stopRecording(id).then((samples) => {
            if (slotAt(address) === current && current.state === 'recording') completeRecording(address, samples);
          });
          continue;
        }
        engine.cancelRecording(id);
        recordingModeRef.current.delete(id);
        recordingWasEmptyRef.current.delete(id);
        current.recordingPeaks = [];
        current.state = current.samples ? 'stopped' : 'empty';
      }
    }
  }

  function startRecording(address: SlotAddress, time: number): void {
    const engine = engineRef.current!;
    const current = slotAt(address);
    const id = engineSlot(address);
    lastSampleEventRef.current = { address, time };
    recordingWasEmptyRef.current.set(id, current.samples === null);
    recordingModeRef.current.set(id, settingsRef.current.recordingMode);
    engine.startRecording(id);
    current.state = 'recording';
    current.recordingPeaks = [];
    selectSlot(address);
  }

  function completeRecording(address: SlotAddress, samples: Slot['samples']): void {
    if (!samples) return;
    const engine = engineRef.current!;
    const current = slotAt(address);
    const id = engineSlot(address);
    current.samples = samples;
    current.sampleRate = engine.sampleRate;
    current.peaks = computePeaks(samples);
    current.recordingPeaks = [];
    current.state = 'stopped';
    current.takePending = recordingModeRef.current.get(id) === 'take';
    recordingModeRef.current.delete(id);
    recordingWasEmptyRef.current.delete(id);
    engine.loadSlotBuffer(id, samples);
    deletedSlotsRef.current.delete(id);
    selectSlot(address);
    scheduleAutoSave();
  }

  function handleSampleNoteOn(address: SlotAddress, time: number, playbackOffsetMs?: number): void {
    const deleteTime = lastDeleteEventTimeRef.current;
    if (deleteTime !== null && time - deleteTime <= DELETE_WINDOW_MS) {
      deleteSlot(address);
      return;
    }

    const engine = engineRef.current!;
    const current = slotAt(address);
    const id = engineSlot(address);
    if (current.state === 'empty') {
      if (!clockRunningRef.current) return;
      startRecording(address, time);
    } else if (current.state === 'recording' && recordingTailTimeoutRef.current.has(id)) {
      // The following pattern cycle can start before the recording tail has
      // flushed. Play the capture so far while the worklet keeps recording.
      lastSampleEventRef.current = { address, time };
      if (recordingModeRef.current.get(id) === 'take') {
        // A new Take-mode note ends the prior take now, rather than waiting
        // for its tail. Once flushed, immediately begin the new take.
        cancelRecordingTail(address);
        void engine.stopRecording(id).then((samples) => {
          if (slotAt(address) !== current || current.state !== 'recording') return;
          completeRecording(address, samples);
          if (clockRunningRef.current && settingsRef.current.recordingMode === 'take') {
            startRecording(address, time);
          }
        });
      } else {
        void engine.snapshotRecording(id).then((samples) => {
          if (slotAt(address) !== current || current.state !== 'recording') return;
          engine.loadSlotBuffer(id, samples);
          engine.play(id, current.mixer, settingsRef.current.recordingTailMs, settingsRef.current.recordingLatencyMs);
        });
      }
    } else if (current.state === 'recording') {
      // Note On while the note that began this recording is still held: no-op.
    } else if (settingsRef.current.recordingMode === 'take' && current.takePending && clockRunningRef.current) {
      startRecording(address, time);
    } else {
      lastSampleEventRef.current = { address, time };
      if (clockRunningRef.current && current.takePending) return;
      const mixer = settingsRef.current.channelMode
        ? { level: 1, pan: address.bank === BANK_A ? -1 : 1, lpfCutoff: 1, hpfCutoff: 0 }
        : current.mixer;
      const startOffsetMs = playbackOffsetMs ?? settingsRef.current.recordingLatencyMs;
      engine.play(id, mixer, settingsRef.current.recordingTailMs, startOffsetMs);
      current.state = 'playing';
      if (!clockRunningRef.current) selectSlot(address);
      const sampleDurationMs = current.samples ? (current.samples.left.length / current.sampleRate) * 1000 : 0;
      const durationMs = Math.max(0, sampleDurationMs - startOffsetMs);
      const startProgress = sampleDurationMs > 0 ? Math.min(1, startOffsetMs / sampleDurationMs) : 0;
      playbackStartRef.current.set(id, { startedAt: performance.now(), durationMs, startProgress });
    }
  }

  function handleSampleNoteOff(address: SlotAddress): void {
    const engine = engineRef.current!;
    const current = slotAt(address);
    const id = engineSlot(address);
    if (current.state === 'recording') {
      cancelRecordingTail(address);
      const tailMs = settingsRef.current.recordingTailMs;
      const finishRecording = () => {
        if (slotAt(address) !== current || current.state !== 'recording') return;
        void engine.stopRecording(id).then((samples) => {
          // The slot may have been deleted while the flush was in flight.
          if (slotAt(address) !== current) return;
          completeRecording(address, samples);
        });
      };
      if (tailMs === 0) {
        finishRecording();
        return;
      }
      const timeout = setTimeout(() => {
        recordingTailTimeoutRef.current.delete(id);
        finishRecording();
      }, tailMs);
      recordingTailTimeoutRef.current.set(id, timeout);
    } else if (current.state === 'playing') {
      // engine.stop() intentionally suppresses its own onended callback (to
      // avoid racing the natural-end path below), so flip state here instead.
      engine.stop(id);
      current.state = 'stopped';
      playbackStartRef.current.delete(id);
    }
  }

  function handleDeleteNote(time: number): void {
    if (standaloneDeleteTimeoutRef.current) clearTimeout(standaloneDeleteTimeoutRef.current);
    lastDeleteEventTimeRef.current = time;
    if (checkDeleteAgainstSampleEvent(time)) {
      lastDeleteEventTimeRef.current = null;
      return;
    }
    standaloneDeleteTimeoutRef.current = setTimeout(() => {
      standaloneDeleteTimeoutRef.current = null;
      if (lastDeleteEventTimeRef.current !== time) return;
      lastDeleteEventTimeRef.current = null;
      const slot = selectedSlotRef.current;
      if (clockRunningRef.current && slot !== null) deleteSlot(slot);
    }, DELETE_WINDOW_MS);
  }

  function setCountInEnabled(enabled: boolean): void {
    setSettings((prev) => {
      if (prev.countInEnabled === enabled) return prev;
      const next = { ...prev, countInEnabled: enabled };
      saveSettings(next);
      return next;
    });
  }

  function sendTransportStop(): void {
    expectedTransportEchoRef.current = { type: 'stop', expiresAt: performance.now() + TRANSPORT_ECHO_WINDOW_MS };
    sentTransportEventsRef.current.push('stop');
    midiRef.current?.sendStop();
  }

  function sendTransportStart(): void {
    expectedTransportEchoRef.current = { type: 'start', expiresAt: performance.now() + TRANSPORT_ECHO_WINDOW_MS };
    sentTransportEventsRef.current.push('start');
    midiRef.current?.sendStart();
  }

  function finishCountIn(): void {
    if (countInStateRef.current !== 'counting') return;
    if (countInTimerRef.current) clearTimeout(countInTimerRef.current);
    countInTimerRef.current = null;
    countInStateRef.current = 'idle';
    setCountInCounting(false);
    sendTransportStart();
  }

  function cancelCountIn(): void {
    if (countInTimerRef.current) clearTimeout(countInTimerRef.current);
    countInTimerRef.current = null;
    engineRef.current?.stopCountInClicks();
    countInStateRef.current = 'idle';
    setCountInCounting(false);
  }

  function recentClockIntervalMs(): number | null {
    const times = clockTimesRef.current;
    if (times.length < 2) return null;
    return (times[times.length - 1]! - times[0]!) / (times.length - 1);
  }

  function startCountIn(): void {
    if (countInStateRef.current === 'counting') return;
    const clockIntervalMs = recentClockIntervalMs();
    clockRunningRef.current = true;
    setClockRunning(true);
    sendTransportStop();
    countInStateRef.current = 'counting';
    countInClockCountRef.current = 0;
    setCountInCounting(true);
    if (clockIntervalMs !== null) {
      engineRef.current?.playCountInClicks(settingsRef.current.countInBeats, clockIntervalMs * 24 / 1000);
      countInTimerRef.current = setTimeout(finishCountIn, settingsRef.current.countInBeats * 24 * clockIntervalMs);
    }
  }

  function isExpectedTransportEcho(type: 'start' | 'stop'): boolean {
    const expected = expectedTransportEchoRef.current;
    if (!expected) return false;
    if (performance.now() > expected.expiresAt) {
      expectedTransportEchoRef.current = null;
      return false;
    }
    if (expected.type !== type) return false;
    expectedTransportEchoRef.current = null;
    return true;
  }

  function handleCc(controller: number, value: number): void {
    const s = settingsRef.current;
    if (s.channelMode) return;
    if (controller === s.masterLevelCc) {
      const masterLevel = value / 127;
      engineRef.current?.setMasterLevel(masterLevel);
      updateSettings({ masterLevel });
      return;
    }
    const address = selectedSlotRef.current;
    if (address === null) return;
    const current = slotAt(address);
    if (controller === s.levelCc) current.mixer.level = value / 127;
    else if (controller === s.panCc) current.mixer.pan = (value / 127) * 2 - 1;
    else if (controller === s.lpfCc) current.mixer.lpfCutoff = value / 127;
    else if (controller === s.hpfCc) current.mixer.hpfCutoff = value / 127;
    else return;
    engineRef.current?.updateMixer(engineSlot(address), current.mixer);
    selectSlot(address);
    scheduleAutoSave();
  }

  function handleMidiEvent(event: MidiEvent): void {
    const s = settingsRef.current;
    if (event.type === 'clock') {
      const times = clockTimesRef.current;
      times.push(event.timeStamp);
      if (times.length > TEMPO_SMOOTHING_WINDOW + 1) times.shift();
      clocksSinceStartRef.current += 1;
      if (clocksSinceStartRef.current >= MIN_BPM_STABLE_CLOCKS) {
        const next = calcBpm(times);
        if (next !== null) setBpm(Math.round(next));
      }
      if (countInStateRef.current === 'counting') {
        countInClockCountRef.current += 1;
        if (countInClockCountRef.current >= s.countInBeats * 24) {
          finishCountIn();
        }
      }
      return;
    }
    if (event.type === 'start') {
      if (isExpectedTransportEcho('start')) {
        countInStateRef.current = 'idle';
        return;
      }
      clockRunningRef.current = true;
      setClockRunning(true);
      if (s.countInEnabled) {
        startCountIn();
      } else {
        clockTimesRef.current = [];
        clocksSinceStartRef.current = 0;
        setBpm(null);
      }
      return;
    }
    if (event.type === 'stop') {
      if (isExpectedTransportEcho('stop')) return;
      clockRunningRef.current = false;
      setClockRunning(false);
      stopInProgressRecordings();
      stopPlayback();
      clockTimesRef.current = [];
      clocksSinceStartRef.current = 0;
      setBpm(null);
      cancelCountIn();
      return;
    }
    if (event.type === 'noteon') {
      const bank = s.channelMode
        ? event.channel === s.channelAMidiChannel ? BANK_A : event.channel === s.channelBMidiChannel ? BANK_B : null
        : event.channel === s.midiChannel ? BANK_A : null;
      if (bank === null) return;
      const time = performance.now();
      const slot = event.note - s.firstSampleNote;
      if (slot >= 0 && slot < SLOT_COUNT) flashSlot({ bank, slot });
      if (event.note === s.channelSwitchNote) {
        if (s.channelMode) {
          clearDeleteGesture();
          clearSelection();
          setActiveBankValue(bank);
        }
        return;
      }
      if (event.note === s.countInOnNote) { setCountInEnabled(true); return; }
      if (event.note === s.countInOffNote) { setCountInEnabled(false); return; }
      if (event.note === s.deleteNote) { handleDeleteNote(time); return; }
      if (event.note === s.oneShotModeNote) { updateSettings({ recordingMode: 'one-shot' }); return; }
      if (event.note === s.takeModeNote) {
        const selected = selectedSlotRef.current;
        if (s.recordingMode === 'take' && selected) {
          const current = slotAt(selected);
          const lastSampleEvent = lastSampleEventRef.current;
          const elapsedSinceTriggerMs = lastSampleEvent
            && lastSampleEvent.address.bank === selected.bank
            && lastSampleEvent.address.slot === selected.slot
            ? Math.max(0, time - lastSampleEvent.time)
            : 0;
          const playbackOffsetMs = settingsRef.current.recordingLatencyMs + elapsedSinceTriggerMs;
          if (current.state === 'recording') {
            const id = engineSlot(selected);
            cancelRecordingTail(selected);
            if (current.samples) {
              engineRef.current!.cancelRecording(id);
              recordingModeRef.current.delete(id);
              recordingWasEmptyRef.current.delete(id);
              current.recordingPeaks = [];
              current.state = 'stopped';
              current.takePending = false;
              scheduleAutoSave();
              handleSampleNoteOn(selected, time, playbackOffsetMs);
              return;
            }
            void engineRef.current!.stopRecording(id).then((samples) => {
              if (slotAt(selected) !== current || current.state !== 'recording') return;
              completeRecording(selected, samples);
              current.takePending = false;
              scheduleAutoSave();
              handleSampleNoteOn(selected, time, playbackOffsetMs);
            });
          } else {
            const wasPending = current.takePending;
            current.takePending = false;
            scheduleAutoSave();
            if (wasPending) handleSampleNoteOn(selected, time, playbackOffsetMs);
          }
        } else {
          updateSettings({ recordingMode: 'take' });
        }
        return;
      }
      if (countInStateRef.current !== 'idle') return;
      if (slot >= 0 && slot < SLOT_COUNT) {
        if (lastDeleteEventTimeRef.current !== null && time - lastDeleteEventTimeRef.current <= DELETE_WINDOW_MS) {
          if (standaloneDeleteTimeoutRef.current) clearTimeout(standaloneDeleteTimeoutRef.current);
          standaloneDeleteTimeoutRef.current = null;
        }
        handleSampleNoteOn({ bank, slot }, time);
      }
      return;
    }
    if (event.type === 'noteoff') {
      const bank = s.channelMode
        ? event.channel === s.channelAMidiChannel ? BANK_A : event.channel === s.channelBMidiChannel ? BANK_B : null
        : event.channel === s.midiChannel ? BANK_A : null;
      if (bank === null) return;
      if (countInStateRef.current !== 'idle') return;
      const slot = event.note - s.firstSampleNote;
      if (slot >= 0 && slot < SLOT_COUNT) handleSampleNoteOff({ bank, slot });
      return;
    }
    if (event.type === 'cc') {
      if (s.channelMode) return;
      if (event.channel !== s.midiChannel) return;
      handleCc(event.controller, event.value);
    }
  }

  async function init(opts?: { silent?: boolean }): Promise<void> {
    if (initPromiseRef.current) {
      await initPromiseRef.current;
      if (!opts?.silent && initErrorRef.current) setError(initErrorRef.current);
      return;
    }
    const pending = initialize(opts);
    initPromiseRef.current = pending;
    try {
      await pending;
    } finally {
      if (initPromiseRef.current === pending) initPromiseRef.current = null;
    }
  }

  async function initialize(opts?: { silent?: boolean }): Promise<void> {
    try {
      // init() can run twice (auto-init on mount + a manual button click) -
      // dispose any previous engine/MIDI connection first, otherwise two
      // live MIDI listeners double-count every Clock pulse (halving the
      // measured interval, and roughly doubling the estimated BPM).
      await engineRef.current?.dispose();
      midiRef.current?.dispose();
      engineRef.current = null;
      midiRef.current = null;

      const engine = new SamplerEngine();
      await engine.init();
      engineRef.current = engine;
      engine.setFilterSlope(settingsRef.current.filterSlopeStages);
      engine.setMasterLevel(settingsRef.current.masterLevel);
      setAudioInputChannelCount(engine.inputChannels);
      setSelectedAudioInputChannelPairStart(engine.selectedInputChannelPairStart);
      setAudioOutputChannelCount(engine.outputChannels);
      setSelectedAudioOutputChannelPairStart(engine.selectedOutputChannelPairStart);
      setInputLevelAnalysers(engine.inputLevelAnalysers);
      setMasterLevelAnalysers(engine.masterLevelAnalysers);
      engine.onRecordingProgress((id, peak) => {
        const s = slotAt({ bank: Math.floor(id / SLOT_COUNT) as BankIndex, slot: id % SLOT_COUNT });
        if (s && s.state === 'recording') {
          s.recordingPeaks.push(peak);
          if (s.recordingPeaks.length > 200) s.recordingPeaks.shift();
        }
      });
      engine.onPlaybackEnded((id) => {
        const s = slotAt({ bank: Math.floor(id / SLOT_COUNT) as BankIndex, slot: id % SLOT_COUNT });
        if (s && s.state === 'playing') s.state = 'stopped';
        playbackStartRef.current.delete(id);
      });

      const midi = new MidiEngine();
      await midi.init();
      midiRef.current = midi;
      midi.on(handleMidiEvent);

      const inputs = await engine.listInputDevices();
      const outputs = await engine.listOutputDevices();
      setAudioInputs(inputs);
      setAudioOutputs(outputs);
      const midiIns = midi.listInputs();
      const midiOuts = midi.listOutputs();
      setMidiInputs(midiIns);
      setMidiOutputs(midiOuts);

      const rememberedIn = findRememberedDevice(inputs, 'audio-in') ?? inputs.find((d) => d.deviceId === engine.inputDeviceId);
      if (rememberedIn) setSelectedAudioInputId(rememberedIn.deviceId);
      if (rememberedIn && rememberedIn.deviceId !== engine.inputDeviceId) {
        await engine.setInputDevice(rememberedIn.deviceId);
      }
      restoreRememberedInputChannelPair(engine);

      const rememberedOut = findRememberedDevice(outputs, 'audio-out');
      if (rememberedOut) {
        setSelectedAudioOutputId(rememberedOut.deviceId);
        await engine.setOutputDevice(rememberedOut.deviceId);
      }
      restoreRememberedOutputChannelPair(engine);

      const rememberedMidiIn = findRememberedDevice(midiIns, 'midi-in');
      if (rememberedMidiIn) {
        setSelectedMidiInputId(rememberedMidiIn.id);
        midi.setInputDevice(rememberedMidiIn.id);
      }
      const rememberedMidiOut = findRememberedDevice(midiOuts, 'midi-out');
      if (rememberedMidiOut) {
        setSelectedMidiOutputId(rememberedMidiOut.id);
        midi.setOutputDevice(rememberedMidiOut.id);
      }

      const lastProjectIndex = settingsRef.current.lastProjectIndex;
      const initialProjectIndex = lastProjectIndex >= 1 && lastProjectIndex <= PROJECT_COUNT ? lastProjectIndex : 1;
      const loaded = await loadProject(initialProjectIndex);
      projectRef.current = loaded;
      deletedSlotsRef.current.clear();
      projectIndexRef.current = initialProjectIndex;
      for (const bank of [BANK_A, BANK_B] as const) {
        for (let slot = 0; slot < SLOT_COUNT; slot++) {
          const address = { bank, slot };
          const s = slotAt(address);
          if (s.samples) engine.loadSlotBuffer(engineSlot(address), s.samples);
        }
      }
      setProjectIndex(initialProjectIndex);
      refreshProject();
      initErrorRef.current = null;
      setReady(true);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      initErrorRef.current = message;
      if (!opts?.silent) setError(message);
    }
  }

  useEffect(() => {
    navigator.permissions
      ?.query({ name: 'microphone' as PermissionName })
      .then((status) => {
        if (status.state === 'granted') void init({ silent: true });
      })
      .catch(() => {});
    // Runs once on mount; init() itself is stable across renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!ready) return;
    const id = setInterval(() => {
      refreshProject();
      const now = performance.now();
      setPlaybackProgress(
        Array.from({ length: SLOT_COUNT }, (_, slot) => {
          const info = playbackStartRef.current.get(engineSlot({ bank: activeBank, slot }));
          if (!info || info.durationMs <= 0) return null;
          return Math.min(1, info.startProgress + ((now - info.startedAt) / info.durationMs) * (1 - info.startProgress));
        }),
      );
      const times = clockTimesRef.current;
      const lastClockAt = times[times.length - 1];
      if (lastClockAt !== undefined) {
        const avgInterval = times.length >= 2 ? (lastClockAt - times[0]!) / (times.length - 1) : CLOCK_STALE_FALLBACK_MS;
        const staleAfterMs = Math.max(CLOCK_STALE_FALLBACK_MS, avgInterval * CLOCK_STALE_MULTIPLIER);
        if (now - lastClockAt > staleAfterMs) {
          clockTimesRef.current = [];
          setBpm(null);
        }
      }
      setTick((t) => t + 1);
    }, UI_TICK_MS);
    return () => clearInterval(id);
  }, [ready, activeBank]);

  useEffect(() => () => {
    if (countInTimerRef.current) clearTimeout(countInTimerRef.current);
    if (standaloneDeleteTimeoutRef.current) clearTimeout(standaloneDeleteTimeoutRef.current);
    for (const timeout of recordingTailTimeoutRef.current.values()) clearTimeout(timeout);
    void engineRef.current?.dispose();
    midiRef.current?.dispose();
  }, []);

  async function selectAudioInput(deviceId: string): Promise<void> {
    const engine = engineRef.current;
    if (!engine) return;
    await engine.setInputDevice(deviceId);
    setSelectedAudioInputId(deviceId);
    restoreRememberedInputChannelPair(engine);
    const device = audioInputs.find((d) => d.deviceId === deviceId);
    rememberDeviceName('audio-in', device?.label);
  }

  function restoreRememberedInputChannelPair(engine: SamplerEngine): void {
    const pairStart = getRememberedDeviceNumber('audio-in-channel-pair');
    if (pairStart !== null && pairStart + 1 < engine.inputChannels) engine.setInputChannelPair(pairStart);
    setAudioInputChannelCount(engine.inputChannels);
    setSelectedAudioInputChannelPairStart(engine.selectedInputChannelPairStart);
  }

  function selectAudioInputChannelPair(start: number): void {
    const engine = engineRef.current;
    if (!engine) return;
    engine.setInputChannelPair(start);
    setSelectedAudioInputChannelPairStart(engine.selectedInputChannelPairStart);
    rememberDeviceNumber('audio-in-channel-pair', engine.selectedInputChannelPairStart);
  }

  async function selectAudioOutput(deviceId: string): Promise<void> {
    const engine = engineRef.current;
    if (!engine) return;
    await engine.setOutputDevice(deviceId);
    setSelectedAudioOutputId(deviceId);
    restoreRememberedOutputChannelPair(engine);
    const device = audioOutputs.find((d) => d.deviceId === deviceId);
    rememberDeviceName('audio-out', device?.label);
  }

  function restoreRememberedOutputChannelPair(engine: SamplerEngine): void {
    const pairStart = getRememberedDeviceNumber('audio-out-channel-pair');
    if (pairStart !== null && pairStart + 1 < engine.outputChannels) engine.setOutputChannelPair(pairStart);
    setAudioOutputChannelCount(engine.outputChannels);
    setSelectedAudioOutputChannelPairStart(engine.selectedOutputChannelPairStart);
  }

  function selectAudioOutputChannelPair(start: number): void {
    const engine = engineRef.current;
    if (!engine) return;
    engine.setOutputChannelPair(start);
    setSelectedAudioOutputChannelPairStart(engine.selectedOutputChannelPairStart);
    rememberDeviceNumber('audio-out-channel-pair', engine.selectedOutputChannelPairStart);
  }

  function selectMidiInput(id: string): void {
    midiRef.current?.setInputDevice(id);
    setSelectedMidiInputId(id);
    const device = midiInputs.find((d) => d.id === id);
    rememberDeviceName('midi-in', device?.name);
  }

  function selectMidiOutput(id: string): void {
    midiRef.current?.setOutputDevice(id);
    setSelectedMidiOutputId(id);
    const device = midiOutputs.find((d) => d.id === id);
    rememberDeviceName('midi-out', device?.name);
  }

  function updateSettings(patch: Partial<SamplerSettings>): void {
    if (patch.recordingTailMs !== undefined) {
      patch = { ...patch, recordingTailMs: Math.max(0, Math.min(MAX_RECORDING_TAIL_MS, Math.round(patch.recordingTailMs))) };
    }
    if (patch.recordingLatencyMs !== undefined) {
      patch = { ...patch, recordingLatencyMs: Math.max(0, Math.min(MAX_RECORDING_LATENCY_MS, Math.round(patch.recordingLatencyMs))) };
    }
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      saveSettings(next);
      if (patch.filterSlopeStages) engineRef.current?.setFilterSlope(patch.filterSlopeStages);
      if (patch.masterLevel !== undefined) engineRef.current?.setMasterLevel(patch.masterLevel);
      return next;
    });
  }

  useEffect(() => {
    engineRef.current?.setMonitor(settings.channelMode, activeBank === BANK_A ? -1 : 1);
  }, [ready, settings.channelMode, activeBank]);

  function isSlotPlaying(slot: number): boolean {
    return engineRef.current?.isPlaying(engineSlot({ bank: activeBank, slot })) ?? false;
  }

  async function selectProject(index: number): Promise<void> {
    const engine = engineRef.current;
    if (!engine || index === projectIndexRef.current) return;
    if (autoSaveTimeoutRef.current) clearTimeout(autoSaveTimeoutRef.current);
    await saveProject(projectIndexRef.current, projectRef.current);

    for (const bank of [BANK_A, BANK_B] as const) {
      for (let slot = 0; slot < SLOT_COUNT; slot++) {
        const address = { bank, slot };
        const s = slotAt(address);
        const id = engineSlot(address);
        if (s.state === 'recording') {
          cancelRecordingTail(address);
          engine.cancelRecording(id);
        }
        if (s.state === 'playing') engine.stop(id);
      }
    }

    const loaded = await loadProject(index);
    projectRef.current = loaded;
    deletedSlotsRef.current.clear();
    projectIndexRef.current = index;
    updateSettings({ lastProjectIndex: index });
    clearSelection();
    for (const bank of [BANK_A, BANK_B] as const) {
      for (let slot = 0; slot < SLOT_COUNT; slot++) {
        const address = { bank, slot };
        engine.clearSlotBuffer(engineSlot(address));
        const s = slotAt(address);
        if (s.samples) engine.loadSlotBuffer(engineSlot(address), s.samples);
      }
    }
    setProjectIndex(index);
    refreshProject();
  }

  async function initializeProject(): Promise<void> {
    const engine = engineRef.current;
    if (!engine) return;
    if (autoSaveTimeoutRef.current) clearTimeout(autoSaveTimeoutRef.current);

    for (const bank of [BANK_A, BANK_B] as const) {
      for (let slot = 0; slot < SLOT_COUNT; slot++) {
        const address = { bank, slot };
        const id = engineSlot(address);
        cancelRecordingTail(address);
        engine.cancelRecording(id);
        engine.stop(id);
        engine.clearSlotBuffer(id);
      }
    }

    const emptyProject = makeDefaultProject();
    projectRef.current = emptyProject;
    deletedSlotsRef.current.clear();
    clearSelection();
    playbackStartRef.current.clear();
    await saveProject(projectIndexRef.current, emptyProject);
    refreshProject();
    setRestoreStatus('');
  }

  async function downloadProjects(): Promise<void> {
    await saveProject(projectIndexRef.current, projectRef.current);
    const blob = await downloadAllProjects();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'loop-pad-projects.zip';
    a.click();
    URL.revokeObjectURL(url);
  }

  async function restoreFromFile(file: File): Promise<void> {
    try {
      const buffer = await file.arrayBuffer();
      if (file.name.toLowerCase().endsWith('.zip')) {
        const { restored } = await restoreProjectsFromZip(buffer);
        setRestoreStatus(restored.length > 0 ? `Restored ${restored.join(', ')}` : 'No matching project files found in ZIP');
      } else {
        await restoreSingleProject(projectIndexRef.current, buffer);
        setRestoreStatus(`Restored into project ${projectIndexRef.current}`);
      }
      // Reload the currently selected project in case it was overwritten.
      const engine = engineRef.current!;
      const loaded = await loadProject(projectIndexRef.current);
      projectRef.current = loaded;
      deletedSlotsRef.current.clear();
      for (const bank of [BANK_A, BANK_B] as const) {
        for (let slot = 0; slot < SLOT_COUNT; slot++) {
          const address = { bank, slot };
          const id = engineSlot(address);
          engine.clearSlotBuffer(id);
          const s = slotAt(address);
          if (s.samples) engine.loadSlotBuffer(id, s.samples);
        }
      }
      refreshProject();
    } catch (e) {
      setRestoreStatus(e instanceof Error ? e.message : String(e));
    }
  }

  async function clearProjectMemory(): Promise<void> {
    if (autoSaveTimeoutRef.current) clearTimeout(autoSaveTimeoutRef.current);
    await clearAllProjects();

    const engine = engineRef.current;
    if (engine) {
      for (const bank of [BANK_A, BANK_B] as const) {
        for (let slot = 0; slot < SLOT_COUNT; slot++) {
          const address = { bank, slot };
          cancelRecordingTail(address);
          engine.cancelRecording(engineSlot(address));
          engine.clearSlotBuffer(engineSlot(address));
        }
      }
    }
    const emptyProject = makeDefaultProject();
    projectRef.current = emptyProject;
    deletedSlotsRef.current.clear();
    projectIndexRef.current = 1;
    updateSettings({ lastProjectIndex: 1 });
    clearSelection();
    playbackStartRef.current.clear();
    setProjectIndex(1);
    refreshProject();
    setRestoreStatus('Project memory cleared');
    setError(null);
  }

  return useMemo(
    () => ({
      ready, error, init,
      audioInputs, selectedAudioInputId, selectAudioInput,
      audioInputChannelCount, selectedAudioInputChannelPairStart, selectAudioInputChannelPair,
      audioOutputs, selectedAudioOutputId, selectAudioOutput,
      audioOutputChannelCount, selectedAudioOutputChannelPairStart, selectAudioOutputChannelPair,
      midiInputs, selectedMidiInputId, selectMidiInput,
      midiOutputs, selectedMidiOutputId, selectMidiOutput,
      settings, updateSettings,
      isSlotPlaying,
      projectIndex, selectProject, initializeProject, projectCount: PROJECT_COUNT,
      project, activeBank, bpm, clockRunning, countInCounting, playbackProgress, tick, selectedSlot, flashingSlots,
      downloadProjects, restoreFromFile, clearProjectMemory, restoreStatus, inputLevelAnalysers, masterLevelAnalysers,
      startCountIn,
      /** Test-only: drives MIDI handling directly, bypassing real hardware. */
      simulateMidiEvent: handleMidiEvent,
      getSentTransportEvents: () => [...sentTransportEventsRef.current],
    }),
    // Re-derive whenever any piece of exposed state changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      ready, error, audioInputs, selectedAudioInputId, audioInputChannelCount, selectedAudioInputChannelPairStart,
      audioOutputs, selectedAudioOutputId,
      audioOutputChannelCount, selectedAudioOutputChannelPairStart,
      midiInputs, selectedMidiInputId, midiOutputs, selectedMidiOutputId,
      settings, projectIndex, project, activeBank, bpm, clockRunning, countInCounting, playbackProgress, tick, selectedSlot, flashingSlots, restoreStatus,
      inputLevelAnalysers, masterLevelAnalysers,
    ],
  );
}
