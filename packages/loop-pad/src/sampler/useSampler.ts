// useSampler — the sampler's controller: routes MIDI events to the audio
// engine and 16-slot project state, handles delete-note timing, CC->mixer
// routing to the last-triggered slot, count-in transport interception, and
// project switching/persistence. UI components only read the returned state
// and call the handful of setting/project handlers; all MIDI-driven state
// changes happen on refs so the audio/MIDI callbacks never see stale data.

import { useEffect, useMemo, useRef, useState } from 'react';
import { SamplerEngine } from '../audio/samplerEngine';
import { MidiEngine, type MidiDeviceRef, type MidiEvent } from '../midi/midiEngine';
import { computePeaks, makeDefaultProject, makeDefaultSlot, SLOT_COUNT, type Project } from './model';
import {
  clearAllProjects, loadProject, saveProject, downloadAllProjects,
  restoreProjectsFromZip, restoreSingleProject, PROJECT_COUNT,
} from './session';
import { loadSettings, saveSettings, type SamplerSettings } from './settings';
import {
  findRememberedDevice, getRememberedDeviceName, getRememberedDeviceNumber,
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

  const engineRef = useRef<SamplerEngine | null>(null);
  const midiRef = useRef<MidiEngine | null>(null);
  const projectRef = useRef<Project>(project);
  const projectIndexRef = useRef(1);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const lastTriggeredSlotRef = useRef<number | null>(null);
  const lastSampleEventRef = useRef<{ slot: number; time: number } | null>(null);
  const lastDeleteEventTimeRef = useRef<number | null>(null);
  const clockTimesRef = useRef<number[]>([]);
  const clockRunningRef = useRef(false);
  const clocksSinceStartRef = useRef(0);
  const countInStateRef = useRef<'idle' | 'counting'>('idle');
  const countInClockCountRef = useRef(0);
  const countInTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const expectedTransportEchoRef = useRef<{ type: 'start' | 'stop'; expiresAt: number } | null>(null);
  const sentTransportEventsRef = useRef<('start' | 'stop')[]>([]);
  const initPromiseRef = useRef<Promise<void> | null>(null);
  const autoSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const playbackStartRef = useRef<Map<number, { startedAt: number; durationMs: number }>>(new Map());

  function scheduleAutoSave(): void {
    if (autoSaveTimeoutRef.current) clearTimeout(autoSaveTimeoutRef.current);
    autoSaveTimeoutRef.current = setTimeout(() => {
      void saveProject(projectIndexRef.current, projectRef.current);
    }, AUTO_SAVE_DEBOUNCE_MS);
  }

  function deleteSlot(slot: number): void {
    const engine = engineRef.current!;
    const current = projectRef.current.slots[slot]!;
    if (current.state === 'recording') engine.cancelRecording(slot);
    engine.clearSlotBuffer(slot);
    projectRef.current.slots[slot] = makeDefaultSlot();
    if (lastTriggeredSlotRef.current === slot) lastTriggeredSlotRef.current = null;
    scheduleAutoSave();
  }

  function checkDeleteAgainstSampleEvent(deleteTime: number): void {
    const last = lastSampleEventRef.current;
    if (last && deleteTime - last.time <= DELETE_WINDOW_MS) deleteSlot(last.slot);
  }

  function stopPlayback(): void {
    const engine = engineRef.current!;
    for (let slot = 0; slot < SLOT_COUNT; slot++) {
      const current = projectRef.current.slots[slot]!;
      if (current.state !== 'playing') continue;
      engine.stop(slot);
      current.state = 'stopped';
    }
    playbackStartRef.current.clear();
  }

  function handleSampleNoteOn(slot: number, time: number): void {
    const deleteTime = lastDeleteEventTimeRef.current;
    if (deleteTime !== null && time - deleteTime <= DELETE_WINDOW_MS) {
      deleteSlot(slot);
      return;
    }

    const engine = engineRef.current!;
    const current = projectRef.current.slots[slot]!;
    if (current.state === 'empty') {
      if (!clockRunningRef.current) return;
      lastSampleEventRef.current = { slot, time };
      lastTriggeredSlotRef.current = slot;
      engine.startRecording(slot);
      current.state = 'recording';
      current.recordingPeaks = [];
    } else if (current.state === 'recording') {
      // Note On while already recording: no-op per spec.
    } else {
      lastSampleEventRef.current = { slot, time };
      lastTriggeredSlotRef.current = slot;
      engine.play(slot, current.mixer);
      current.state = 'playing';
      const durationMs = current.samples ? (current.samples.left.length / current.sampleRate) * 1000 : 0;
      playbackStartRef.current.set(slot, { startedAt: performance.now(), durationMs });
    }
  }

  function handleSampleNoteOff(slot: number): void {
    const engine = engineRef.current!;
    const current = projectRef.current.slots[slot]!;
    if (current.state === 'recording') {
      void engine.stopRecording(slot).then((samples) => {
        // The slot may have been deleted while the flush was in flight.
        if (projectRef.current.slots[slot] !== current) return;
        current.samples = samples;
        current.sampleRate = engine.sampleRate;
        current.peaks = computePeaks(samples);
        current.recordingPeaks = [];
        current.state = 'stopped';
        engine.loadSlotBuffer(slot, samples);
        scheduleAutoSave();
      });
    } else if (current.state === 'playing') {
      // engine.stop() intentionally suppresses its own onended callback (to
      // avoid racing the natural-end path below), so flip state here instead.
      engine.stop(slot);
      current.state = 'stopped';
      playbackStartRef.current.delete(slot);
    }
  }

  function handleDeleteNote(time: number): void {
    lastDeleteEventTimeRef.current = time;
    checkDeleteAgainstSampleEvent(time);
  }

  function toggleCountIn(): void {
    setSettings((prev) => {
      const next = { ...prev, countInEnabled: !prev.countInEnabled };
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
    const slot = lastTriggeredSlotRef.current;
    if (slot === null) return;
    const s = settingsRef.current;
    const current = projectRef.current.slots[slot]!;
    if (controller === s.levelCc) current.mixer.level = value / 127;
    else if (controller === s.panCc) current.mixer.pan = (value / 127) * 2 - 1;
    else if (controller === s.lpfCc) current.mixer.lpfCutoff = value / 127;
    else if (controller === s.hpfCc) current.mixer.hpfCutoff = value / 127;
    else return;
    engineRef.current?.updateMixer(slot, current.mixer);
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
      if (isExpectedTransportEcho('start')) return;
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
      stopPlayback();
      clockTimesRef.current = [];
      clocksSinceStartRef.current = 0;
      setBpm(null);
      cancelCountIn();
      return;
    }
    if (event.type === 'noteon') {
      if (event.channel !== s.midiChannel) return;
      const time = performance.now();
      if (event.note === s.countInToggleNote) { toggleCountIn(); return; }
      if (event.note === s.deleteNote) { handleDeleteNote(time); return; }
      const slot = event.note - s.firstSampleNote;
      if (slot >= 0 && slot < SLOT_COUNT) handleSampleNoteOn(slot, time);
      return;
    }
    if (event.type === 'noteoff') {
      if (event.channel !== s.midiChannel) return;
      const slot = event.note - s.firstSampleNote;
      if (slot >= 0 && slot < SLOT_COUNT) handleSampleNoteOff(slot);
      return;
    }
    if (event.type === 'cc') {
      if (event.channel !== s.midiChannel) return;
      handleCc(event.controller, event.value);
    }
  }

  async function init(opts?: { silent?: boolean }): Promise<void> {
    if (initPromiseRef.current) return initPromiseRef.current;
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
      const rememberedAudioIn = getRememberedDeviceName('audio-in');
      await engine.init();
      engineRef.current = engine;
      engine.setFilterSlope(settingsRef.current.filterSlopeStages);
      setAudioInputChannelCount(engine.inputChannels);
      setSelectedAudioInputChannelPairStart(engine.selectedInputChannelPairStart);
      setAudioOutputChannelCount(engine.outputChannels);
      setSelectedAudioOutputChannelPairStart(engine.selectedOutputChannelPairStart);
      setInputLevelAnalysers(engine.inputLevelAnalysers);
      engine.onRecordingProgress((slot, peak) => {
        const s = projectRef.current.slots[slot];
        if (s && s.state === 'recording') {
          s.recordingPeaks.push(peak);
          if (s.recordingPeaks.length > 200) s.recordingPeaks.shift();
        }
      });
      engine.onPlaybackEnded((slot) => {
        const s = projectRef.current.slots[slot];
        if (s && s.state === 'playing') s.state = 'stopped';
        playbackStartRef.current.delete(slot);
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
      if (rememberedAudioIn && rememberedIn && rememberedIn.label !== rememberedAudioIn) {
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

      const loaded = await loadProject(1);
      projectRef.current = loaded;
      for (let slot = 0; slot < SLOT_COUNT; slot++) {
        const s = loaded.slots[slot]!;
        if (s.samples) engine.loadSlotBuffer(slot, s.samples);
      }
      setProject({ slots: [...loaded.slots] });
      setReady(true);
    } catch (e) {
      if (!opts?.silent) setError(e instanceof Error ? e.message : String(e));
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
      setProject({ slots: [...projectRef.current.slots] });
      const now = performance.now();
      setPlaybackProgress(
        Array.from({ length: SLOT_COUNT }, (_, slot) => {
          const info = playbackStartRef.current.get(slot);
          if (!info || info.durationMs <= 0) return null;
          return Math.min(1, (now - info.startedAt) / info.durationMs);
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
  }, [ready]);

  useEffect(() => () => {
    if (countInTimerRef.current) clearTimeout(countInTimerRef.current);
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
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      saveSettings(next);
      if (patch.filterSlopeStages) engineRef.current?.setFilterSlope(patch.filterSlopeStages);
      return next;
    });
  }

  async function selectProject(index: number): Promise<void> {
    const engine = engineRef.current;
    if (!engine || index === projectIndexRef.current) return;
    if (autoSaveTimeoutRef.current) clearTimeout(autoSaveTimeoutRef.current);
    await saveProject(projectIndexRef.current, projectRef.current);

    for (let slot = 0; slot < SLOT_COUNT; slot++) {
      const s = projectRef.current.slots[slot]!;
      if (s.state === 'recording') engine.cancelRecording(slot);
      if (s.state === 'playing') engine.stop(slot);
    }

    const loaded = await loadProject(index);
    projectRef.current = loaded;
    projectIndexRef.current = index;
    lastTriggeredSlotRef.current = null;
    for (let slot = 0; slot < SLOT_COUNT; slot++) {
      engine.clearSlotBuffer(slot);
      const s = loaded.slots[slot]!;
      if (s.samples) engine.loadSlotBuffer(slot, s.samples);
    }
    setProjectIndex(index);
    setProject({ slots: [...loaded.slots] });
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
      for (let slot = 0; slot < SLOT_COUNT; slot++) {
        engine.clearSlotBuffer(slot);
        const s = loaded.slots[slot]!;
        if (s.samples) engine.loadSlotBuffer(slot, s.samples);
      }
      setProject({ slots: [...loaded.slots] });
    } catch (e) {
      setRestoreStatus(e instanceof Error ? e.message : String(e));
    }
  }

  async function clearProjectMemory(): Promise<void> {
    if (autoSaveTimeoutRef.current) clearTimeout(autoSaveTimeoutRef.current);
    await clearAllProjects();

    const engine = engineRef.current;
    if (engine) {
      for (let slot = 0; slot < SLOT_COUNT; slot++) engine.clearSlotBuffer(slot);
    }
    const emptyProject = makeDefaultProject();
    projectRef.current = emptyProject;
    projectIndexRef.current = 1;
    lastTriggeredSlotRef.current = null;
    playbackStartRef.current.clear();
    setProjectIndex(1);
    setProject({ slots: [...emptyProject.slots] });
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
      projectIndex, selectProject, projectCount: PROJECT_COUNT,
      project, bpm, clockRunning, countInCounting, playbackProgress, tick,
      downloadProjects, restoreFromFile, clearProjectMemory, restoreStatus, inputLevelAnalysers,
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
      settings, projectIndex, project, bpm, clockRunning, countInCounting, playbackProgress, tick, restoreStatus,
      inputLevelAnalysers,
    ],
  );
}
