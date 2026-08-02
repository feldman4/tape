// TapePage — four-lane tape recorder with tabbed UI.
import { useCallback, useEffect, useRef, useState } from 'react';
import { AudioEngine } from '../audio/audioEngine';
import { AudioPool } from '../audio/audioPool';
import { detectOnset } from '../audio/onsetDetect';
import { SyncEngine, type SyncEvent } from '../sync/syncEngine';
import { createClickWaveform } from '../audio/clickWaveform';
import { OpzControlMode, type ControlEvent } from '../sync/opzControlMode';
import { makeDefaultTape, type Clip, type Lane, type Tape } from '../tape/model';
import { finalizeFreeRecording } from '../tape/recording';
import { applyOverwrite, tapeLengthFromLanes, splitClip } from '../tape/editEngine';
import { saveSession, listSessions, loadSession } from '../tape/session';
import { defaultViewWidthSamples, MIN_VIEW_WIDTH_SAMPLES, VIEW_MARGIN } from './canvasConstants';
import { btnStyle } from './btnStyle';
import type { Clipboard, Mode, TransportState, UndoEntry, TapeEngineRefs } from './tapeRefs';
import { useActivityLog } from './hooks/useActivityLog';
import { useTapeDispatch } from './hooks/useTapeDispatch';
import { detectPlatformCapabilities } from './platformCapabilities';
import { useTimelineRender } from './hooks/useTimelineRender';
import { useTapeInput } from './hooks/useTapeInput';
import { useIpadLayout } from './hooks/useIpadLayout';
import { ComTab } from './tabs/ComTab';
import { TapeTab } from './tabs/TapeTab';
import { IpadTapeTab } from './tabs/IpadTapeTab';
import { MixerTab } from './tabs/MixerTab';
import { ProjTab } from './tabs/ProjTab';
import { TestTab } from './tabs/TestTab';
import type { InputLatCalResult } from './tabs/TestTab';

// BPM is not written to tape until this many clocks received — avoids early jitter.
const MIN_BPM_STABLE_CLOCKS = 48; // ~2 beats at 120 BPM

// ---------------------------------------------------------------------------
// Pure helpers (no React deps — safe to call from rAF and render body)
// ---------------------------------------------------------------------------

/** Returns the id of the topmost clip covering the playhead, or null. */
function clipAtPlayhead(clips: Clip[], playhead: number): string | null {
  const matches = clips.filter((c) => playhead >= c.tapeStart && playhead < c.tapeStart + c.duration);
  return matches.length === 0 ? null : matches.reduce((a, b) => b.tapeStart > a.tapeStart ? b : a).id;
}

// Latency defaults (milliseconds)
const DEFAULT_INPUT_LATENCY_MS = 23;
const DEFAULT_OUTPUT_LATENCY_MS = 65;
const DEFAULT_MIDI_LATENCY_MS = 0;

export function TapePage() {
  // ---------------------------------------------------------------------------
  // Engine refs
  // ---------------------------------------------------------------------------
  const engineRef = useRef<AudioEngine | null>(null);
  const syncEngineRef = useRef<SyncEngine | null>(null);
  const ctrlModeRef = useRef<OpzControlMode | null>(null);
  // Updated every render so the OpzControlMode callback always calls the
  // latest versions of handleRecord, handlePlay, etc. (same pattern as addLogFnRef).
  const ctrlModeHandlerRef = useRef<((event: ControlEvent) => void) | null>(null);
  const poolRef = useRef(new AudioPool());
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const poolDisplayRef = useRef<AudioPool>(poolRef.current);

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedAudioDeviceId, setSelectedAudioDeviceId] = useState<string | null>(null);
  const [audioOutputDevices, setAudioOutputDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedAudioOutputId, setSelectedAudioOutputId] = useState<string>('');
  const [midiInputs, setMidiInputs] = useState<{ id: string; name: string | null }[]>([]);
  const [selectedMidiInputId, setSelectedMidiInputId] = useState<string | 'all'>('all');
  const [midiOutputs, setMidiOutputs] = useState<{ id: string; name: string | null }[]>([]);
  const [selectedMidiOutputId, setSelectedMidiOutputId] = useState<string | null>(null);

  const [tape, setTape] = useState<Tape>(makeDefaultTape());
  const [transport, setTransport] = useState<TransportState>('idle');
  const [mode, setMode] = useState<Mode>('sync');
  const modeRef = useRef<Mode>('sync');
  useEffect(() => { modeRef.current = mode; }, [mode]);

  const [snap, setSnap] = useState(true);
  const snapRef = useRef(true);
  useEffect(() => { snapRef.current = snap; }, [snap]);

  const [clipboard, setClipboard] = useState<Clipboard>(null);
  const [undoStack, setUndoStack] = useState<UndoEntry[]>([]);
  const [redoStack, setRedoStack] = useState<UndoEntry[]>([]);

  const [activeTab, setActiveTab] = useState<'COM'|'TAPE'|'MIXER'|'PROJ'|'TEST'>('TAPE');

  const [syncBpm, setSyncBpm] = useState(120);
  const [syncRunning, setSyncRunning] = useState(false);
  const [syncBeatPosition, setSyncBeatPosition] = useState(0);
  const [lastClipBeats, setLastClipBeats] = useState<number | null>(null);

  const [sessions, setSessions] = useState<string[]>([]);
  const [sessionName, setSessionName] = useState('');
  const [sessionStatus, setSessionStatus] = useState('');

  const [midiStartToNoteOffset] = useState<{ offsetMs: number } | { error: string } | null>(null);
  const [testingMidiStartToNote] = useState(false);

  const [outputLatencyMs, setOutputLatencyMs] = useState(DEFAULT_OUTPUT_LATENCY_MS);
  const outputLatencyMsRef = useRef(DEFAULT_OUTPUT_LATENCY_MS);
  outputLatencyMsRef.current = outputLatencyMs;

  const [inputLatencyMs, setInputLatencyMs] = useState(DEFAULT_INPUT_LATENCY_MS);
  const [inputLatCal, setInputLatCal] = useState<InputLatCalResult | null>(null);
  const [calibratingInputLat, setCalibratingInputLat] = useState(false);
  // Input latency from state (inputLatencyMs) — synced to ref for sync recording placement.
  const calibratedInputLatencyMsRef = useRef(DEFAULT_INPUT_LATENCY_MS);
  useEffect(() => {
    calibratedInputLatencyMsRef.current = inputLatencyMs;
  }, [inputLatencyMs]);

  const [midiLatencyMs, setMidiLatencyMs] = useState(DEFAULT_MIDI_LATENCY_MS);
  const midiLatencyMsRef = useRef(DEFAULT_MIDI_LATENCY_MS);
  midiLatencyMsRef.current = midiLatencyMs;

  const [clickEnabled, setClickEnabled] = useState(false);
  const clickEnabledRef = useRef(false);
  clickEnabledRef.current = clickEnabled;

  // ---------------------------------------------------------------------------
  // Refs for real-time values (avoid stale closures in rAF / MIDI callbacks)
  // ---------------------------------------------------------------------------
  const tapeRef = useRef<Tape>(tape);
  tapeRef.current = tape;
  const transportRef = useRef<TransportState>(transport);
  transportRef.current = transport;

  const tapeStartForRecordingRef = useRef(0);
  const recordStartWallTimeRef = useRef(0);
  const midiStartContextTimeRef = useRef(0); // AudioContext time when MIDI Start arrived
  const loopRotateTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loopRotatingRef = useRef(false);
  const armedRef = useRef(false);
  const ignoreNextMidiStartRef = useRef(false);
  const clocksSinceStartRef = useRef(0);
  const cancelCountInRef = useRef<(() => void) | null>(null);

  const selectedClipIdRef = useRef<string | null>(null);
  const viewWidthSamplesRef = useRef(defaultViewWidthSamples(tape.bpm));
  const unsubscribeSyncEngineRef = useRef<(() => void) | null>(null);
  const unsubscribePlayheadRef = useRef<(() => void) | null>(null);
  const lastMidiStartTimeRef = useRef(0);
  const lastScheduledBeatRef = useRef(-1);
  const platformCapabilities = useRef(detectPlatformCapabilities()).current;
  const isIpadLayout = useIpadLayout();

  // ---------------------------------------------------------------------------
  // Activity log
  // ---------------------------------------------------------------------------
  const { activityLogRef, addLogFnRef, forceLogUpdate } = useActivityLog();

  // ---------------------------------------------------------------------------
  // Shared ref bundle — passed to hooks so they don't each take 20 args
  // ---------------------------------------------------------------------------
  const refs: TapeEngineRefs = {
    engineRef, syncEngineRef, ctrlModeRef, ctrlModeHandlerRef,
    poolRef, poolDisplayRef, tapeRef, transportRef, modeRef, snapRef,
    outputLatencyMsRef, calibratedInputLatencyMsRef,
    tapeStartForRecordingRef, recordStartWallTimeRef, midiStartContextTimeRef,
    loopRotateTimeoutRef, loopRotatingRef, armedRef, ignoreNextMidiStartRef, clocksSinceStartRef,
    cancelCountInRef, addLogFnRef, viewWidthSamplesRef, selectedClipIdRef,
  };

  // ---------------------------------------------------------------------------
  // Tape dispatch — single action-based entry point for all state mutations.
  // ---------------------------------------------------------------------------
  const { dispatch, refreshSessions } = useTapeDispatch(refs, {
    setTape, setTransport, setUndoStack, setRedoStack, setClipboard,
    setSessions, setSessionStatus, setSessionName, setMode, setSnap,
    setLastClipBeats, clipboard, sessionName,
  });

  // Thin wrappers preserve existing tab-component prop signatures.
  const handleRecord   = () => dispatch({ type: 'record' });
  const handlePlay     = () => dispatch({ type: 'play' });
  const handleStop     = () => dispatch({ type: 'stop' });
  const handleSplit    = () => dispatch({ type: 'split' });
  const handleJoin     = () => dispatch({ type: 'join' });
  const handleLift     = () => dispatch({ type: 'lift' });
  const handleDrop     = () => dispatch({ type: 'drop' });
  const handleUndo     = () => dispatch({ type: 'undo' });
  const handleRedo     = () => dispatch({ type: 'redo' });
  const handleSetLoopIn    = () => dispatch({ type: 'setLoopIn' });
  const handleSetLoopOut   = () => dispatch({ type: 'setLoopOut' });
  const handleToggleLoop   = () => dispatch({ type: 'toggleLoop' });
  const handleLoopFromClip = () => dispatch({ type: 'loopFromClip' });
  const handleSave         = () => dispatch({ type: 'saveSession' });
  const handleLoad         = (name: string) => dispatch({ type: 'loadSession', name });
  const handleNew          = () => dispatch({ type: 'newSession' });
  const handleDeleteSession = (name: string) => dispatch({ type: 'deleteSession', name });
  const handleLaneGain = (laneIndex: 0|1|2|3, gain: number) => dispatch({ type: 'setLaneGain', lane: laneIndex, gain });
  const handleLanePan  = (laneIndex: 0|1|2|3, pan: number)  => dispatch({ type: 'setLanePan',  lane: laneIndex, pan });
  const handleRecordingGain = (gain: number) => dispatch({ type: 'setRecordingGain', gain });
  const handleLaneMute    = (laneIndex: 0|1|2|3) => dispatch({ type: 'toggleMuteLane', lane: laneIndex });
  const handleToggleClick = useCallback(() => setClickEnabled((v) => !v), []);

  // ---------------------------------------------------------------------------
  // Update view width when loop changes
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const tape = tapeRef.current;
    if (tape.loopEnabled) {
      const loopWidth = Math.abs(tape.loopOut - tape.loopIn);
      if (loopWidth > 0) {
        // Target width: 2x loop width with margin (so loop fills ~50% of screen)
        const targetViewWidth = 2 * loopWidth * (1 + VIEW_MARGIN);
        // Only clamp at minimum — no upper bound while loop is active
        viewWidthSamplesRef.current = Math.max(MIN_VIEW_WIDTH_SAMPLES, targetViewWidth);
      }
    } else {
      const sampleRate = engineRef.current?.sampleRate ?? 44100;
      viewWidthSamplesRef.current = defaultViewWidthSamples(tape.bpm, sampleRate);
    }
  }, [tape.bpm, tape.loopEnabled, tape.loopIn, tape.loopOut]);

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------
  const preferOpZ = <T,>(items: T[], getLabel: (item: T) => string | null): T | undefined =>
    items.find((item) => getLabel(item)?.toLowerCase().includes('op-z')) ?? items[0];

  const handleInit = useCallback(async (opts?: { silent?: boolean }) => {
    try {
      unsubscribeSyncEngineRef.current?.();
      unsubscribeSyncEngineRef.current = null;
      unsubscribePlayheadRef.current?.();
      unsubscribePlayheadRef.current = null;
      ctrlModeRef.current?.dispose();
      ctrlModeRef.current = null;
      syncEngineRef.current?.dispose();
      syncEngineRef.current = null;
      await engineRef.current?.dispose();
      engineRef.current = null;

      const engine = new AudioEngine();
      await engine.init();
      engineRef.current = engine;
      engine.setRecordingGain(tapeRef.current.recordingGain);
      poolDisplayRef.current = poolRef.current;

      const devices = await engine.listInputDevices();
      setAudioDevices(devices);
      const defaultDevice = preferOpZ(devices, (d) => d.label);
      if (defaultDevice && defaultDevice.deviceId !== engine.inputDeviceId) {
        await engine.setInputDevice(defaultDevice.deviceId);
      }
      setSelectedAudioDeviceId(defaultDevice?.deviceId ?? engine.inputDeviceId ?? null);

      const outputDevices = platformCapabilities.audioOutputSelection
        ? await engine.listOutputDevices()
        : [];
      setAudioOutputDevices(outputDevices);
      setSelectedAudioOutputId(engine.outputDeviceId);

      let syncEngine: SyncEngine | null = null;
      let defaultInput: { id: string; name: string | null } | undefined;
      let defaultOutput: { id: string; name: string | null } | undefined;
      if (platformCapabilities.webMidi) {
        syncEngine = new SyncEngine(engine.audioContext);
        await syncEngine.init();
        syncEngineRef.current = syncEngine;

        const inputs = syncEngine.listInputs();
        setMidiInputs(inputs);
        defaultInput = preferOpZ(inputs, (i) => i.name);
        if (defaultInput) { syncEngine.setInputDevice(defaultInput.id); setSelectedMidiInputId(defaultInput.id); }

        const outputs = syncEngine.listOutputs();
        setMidiOutputs(outputs);
        defaultOutput = preferOpZ(outputs, (o) => o.name);
        if (defaultOutput) { syncEngine.setOutputDevice(defaultOutput.id); setSelectedMidiOutputId(defaultOutput.id); }

        const midiAccess = syncEngine.getMIDIAccess();
        if (midiAccess) {
          const ctrlMode = new OpzControlMode(midiAccess);
          ctrlMode.setInputDevice(defaultInput?.id ?? 'all');
          if (defaultOutput) ctrlMode.setOutputDevice(defaultOutput.id);
          ctrlMode.setRecordEnabled(
            transportRef.current === 'armed' || transportRef.current === 'recording',
          );
          ctrlMode.on((event) => ctrlModeHandlerRef.current?.(event));
          ctrlModeRef.current = ctrlMode;
        }
      } else {
        setMidiInputs([]);
        setMidiOutputs([]);
        setSelectedMidiInputId('all');
        setSelectedMidiOutputId(null);
      }

      // Pre-build a reusable click buffer for the metronome (constant; created once per init).
      const clickWf = createClickWaveform(engine.audioContext.sampleRate);
      const clickBuf = engine.audioContext.createBuffer(1, clickWf.length, engine.audioContext.sampleRate);
      clickBuf.copyToChannel(new Float32Array(clickWf), 0);

      const scheduleMetronomeClick = (contextTimeSecs: number, isDownbeat: boolean) => {
        const ctx = engine.audioContext;
        const node = ctx.createBufferSource();
        node.buffer = clickBuf;
        const gainNode = ctx.createGain();
        gainNode.gain.value = isDownbeat ? 1.0 : 0.55;
        node.connect(gainNode);
        gainNode.connect(ctx.destination);
        // Never schedule in the past.
        node.start(Math.max(ctx.currentTime + 0.001, contextTimeSecs));
      };

      // Register syncEngine listener and store unsubscribe function for cleanup
      const unsubscribeSyncEngine = syncEngine?.on((event: SyncEvent) => {
        if (event.type === 'start') {
          // Deduplicate: ignore MIDI Start events that arrive within 10ms of the last one
          const now = Date.now();
          if (now - lastMidiStartTimeRef.current < 10) {
            return;
          }
          lastMidiStartTimeRef.current = now;

          // Record the AudioContext time when MIDI Start arrived
          midiStartContextTimeRef.current = engine.audioContext.currentTime;

          setSyncRunning(true);
          clocksSinceStartRef.current = 0;

          // Snap playhead to nearest beat and anchor the transport estimate there.
          const tape = tapeRef.current;
          const sr = engine.sampleRate;
          const bpm = Math.max(60, tape.bpm);
          const spb = (sr * 60) / bpm;
          const nearestBeatSamples = Math.round(tape.playhead / spb) * spb;
          const nearestBeatSecs = nearestBeatSamples / sr;
          syncEngine.setStartTapeOffset(nearestBeatSecs);

          dispatch({ type: 'midiClockStart', startSamples: Math.max(0, Math.round(nearestBeatSamples)) });

          // Metronome: schedule downbeat for the start moment.
          if (clickEnabledRef.current) {
            scheduleMetronomeClick(engine.audioContext.currentTime + 0.001, true);
          }
        } else if (event.type === 'stop') {
          setSyncRunning(false);
          dispatch({ type: 'midiClockStop' });
          lastScheduledBeatRef.current = -1;
        } else if (event.type === 'clock') {
          clocksSinceStartRef.current += 1;
          setSyncBeatPosition(event.beatPosition);
          if (clocksSinceStartRef.current >= MIN_BPM_STABLE_CLOCKS) {
            setSyncBpm(event.bpm);
            const roundedBpm = Math.round(event.bpm);
            if (roundedBpm !== tapeRef.current.bpm) {
              setTape((prev) => {
                const t = { ...prev, bpm: roundedBpm };
                tapeRef.current = t;
                return t;
              });
            }
          }
          
          // Metronome: schedule clicks based on time since MIDI start, not MIDI clock
          if (clickEnabledRef.current) {
            const timeSinceMidiStart = event.contextTimeSecs - midiStartContextTimeRef.current;
            const bpm = tapeRef.current.bpm;
            const beatDurationSecs = 60 / bpm;
            const beatsSinceMidiStart = timeSinceMidiStart / beatDurationSecs;
            const currentBeat = Math.floor(beatsSinceMidiStart);
            
            // Only schedule if we've moved to a new beat
            if (currentBeat !== lastScheduledBeatRef.current) {
              lastScheduledBeatRef.current = currentBeat;
              const beatTimeSecs = midiStartContextTimeRef.current + (currentBeat * beatDurationSecs);
              
              // Add output latency to the scheduled time
              const latencyCompensatedTime = beatTimeSecs + (midiLatencyMsRef.current / 1000);
              const isDownbeat = (currentBeat % 4) === 0;
              scheduleMetronomeClick(latencyCompensatedTime, isDownbeat);
            }
          }
        }
      }) ?? null;
      unsubscribeSyncEngineRef.current = unsubscribeSyncEngine;

      let wasPlayingWorklet = false;
      unsubscribePlayheadRef.current = engine.onPlayhead(({ tapePosition, playing }) => {
        const engineSr = engine.sampleRate;
        if (playing && !wasPlayingWorklet) {
          addLogFnRef.current(`\u25b6 worklet: started  tape=${(tapePosition / engineSr).toFixed(3)}s`);
        } else if (!playing && wasPlayingWorklet) {
          addLogFnRef.current(`\u23f9 worklet: stopped  tape=${(tapePosition / engineSr).toFixed(3)}s  transportRef=${transportRef.current}`);
          dispatch({ type: 'workletPlaybackStopped' });
        }
        wasPlayingWorklet = playing;
        if (playing) {
          setTape((prev) => ({ ...prev, playhead: tapePosition }));
        }
      });

      const names = await listSessions();
      setSessions(names);

      if (names.includes('init')) {
        const result = await loadSession('init');
        if (result) {
          poolRef.current = result.pool;
          setTape(result.tape);
          tapeRef.current = result.tape;
          poolDisplayRef.current = result.pool;
          engineRef.current?.loadTape(result.tape.lanes, result.pool);
          engineRef.current?.setRecordingGain(result.tape.recordingGain);
          setMode(result.mode);
          modeRef.current = result.mode;
          setSnap(result.snap);
          snapRef.current = result.snap;
          setSessionName('init');
        }
      }

      setReady(true);
    } catch (err) {
      if (!opts?.silent) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    navigator.permissions
      .query({ name: 'microphone' as PermissionName })
      .then((status) => {
        if (status.state === 'granted') void handleInit({ silent: true });
      })
      .catch(() => {});
    
    return () => {
      // Cleanup on unmount
      unsubscribeSyncEngineRef.current?.();
      unsubscribePlayheadRef.current?.();
      ctrlModeRef.current?.dispose();
      syncEngineRef.current?.dispose();
      void engineRef.current?.dispose();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keyboard shortcuts for tab switching (Option + 1-5)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!e.altKey) return;
      const code = e.code;
      if (code === 'Digit1') {
        e.preventDefault();
        setActiveTab('TAPE');
      } else if (code === 'Digit2') {
        e.preventDefault();
        setActiveTab('MIXER');
      } else if (code === 'Digit3') {
        e.preventDefault();
        setActiveTab('PROJ');
      } else if (code === 'Digit4') {
        e.preventDefault();
        setActiveTab('COM');
      } else if (code === 'Digit5') {
        e.preventDefault();
        setActiveTab('TEST');
      }
    };
    
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  useTimelineRender({
    canvasRef, engineRef, poolRef: poolDisplayRef, tapeRef, transportRef, snapRef,
    tapeStartForRecordingRef, recordStartWallTimeRef, viewWidthSamplesRef,
  });

  // ---------------------------------------------------------------------------
  // Device change handlers
  // ---------------------------------------------------------------------------
  const handleAudioDeviceChange = useCallback(async (deviceId: string) => {
    await engineRef.current?.setInputDevice(deviceId);
    setSelectedAudioDeviceId(deviceId);
  }, []);

  const handleAudioOutputChange = useCallback(async (sinkId: string) => {
    await engineRef.current?.setOutputDevice(sinkId);
    setSelectedAudioOutputId(sinkId);
  }, []);

  const handleMidiInputChange = useCallback((id: string) => {
    syncEngineRef.current?.setInputDevice(id);
    ctrlModeRef.current?.setInputDevice(id);
    setSelectedMidiInputId(id);
  }, []);

  const handleMidiOutputChange = useCallback((id: string) => {
    syncEngineRef.current?.setOutputDevice(id);
    ctrlModeRef.current?.setOutputDevice(id);
    ctrlModeRef.current?.setRecordEnabled(
      transportRef.current === 'armed' || transportRef.current === 'recording',
    );
    setSelectedMidiOutputId(id);
  }, []);

  // ---------------------------------------------------------------------------
  // Test handlers
  // ---------------------------------------------------------------------------
  // MIDI Start→Note test (placeholder)
  const handleMidiStartToNoteTest = useCallback(() => {
    // Placeholder: MIDI Start→Note test handler
  }, []);

  const handleCalibrateInputLatency = useCallback(() => {
    const engine = engineRef.current;
    const sync = syncEngineRef.current;
    if (!engine || !sync || transportRef.current === 'recording') return;
    
    setCalibratingInputLat(true);
    setInputLatCal(null);
    
    const sr = engine.sampleRate;
    let midiStartPerfTime: number | null = null;
    let unsubscribed: (() => void) | null = null;
    
    // Timeout after 15 seconds
    const timeoutId = setTimeout(() => {
      unsubscribed?.();
      void engine.stopRecording().catch(() => {});
      setInputLatCal({ error: 'Timeout: no MIDI Start received' });
      setCalibratingInputLat(false);
    }, 15_000);

    engine.startRecording();

    // Listen for MIDI Start message
    const handleSyncEvent = (event: SyncEvent) => {
      if (event.type !== 'start') return;
      
      // Record the performance time when Start arrived
      // We'll use this to anchor the audio recording to MIDI time
      midiStartPerfTime = performance.now();
      
      // After MIDI Start, record for ~2 seconds to capture multiple clicks
      setTimeout(() => {
        unsubscribed?.();
        engine.stopRecording().then((recording) => {
          clearTimeout(timeoutId);
          
          if (!midiStartPerfTime) {
            setInputLatCal({ error: 'MIDI Start time lost' });
            setCalibratingInputLat(false);
            return;
          }

          // Get AudioContext timestamp to convert MIDI perfTime to audio frame
          const now = performance.now();
          const audioTs = engine.audioContext.getOutputTimestamp();
          if (!audioTs || audioTs.contextTime === undefined) {
            setInputLatCal({ error: 'Failed to get AudioContext timestamp' });
            setCalibratingInputLat(false);
            return;
          }
          const contextNow = audioTs.contextTime;
          
          // How long ago was MIDI Start? (in seconds)
          const timeSinceMidiStart = (now - midiStartPerfTime) / 1000;
          // What was the AudioContext time at MIDI Start?
          const midiStartContextTime = contextNow - timeSinceMidiStart;
          // Convert to audio frame
          const midiStartFrame = midiStartContextTime * sr;

          // Detect onsets in the recording
          const { index: onsetIndex } = detectOnset(recording.samples);
          
          if (onsetIndex === null) {
            setInputLatCal({ error: 'No audio onset detected in recording' });
            setCalibratingInputLat(false);
            return;
          }

          // Calculate latency: how far is the detected onset from the expected MIDI Start time?
          const detectedFrame = recording.startFrame + onsetIndex;
          const offsetMs = ((detectedFrame - midiStartFrame) / sr) * 1000;
          
          setInputLatencyMs(Math.max(0, offsetMs));
          setInputLatCal({ 
            offsetMs,
            beatsDetected: 1,
            totalBeats: 1,
            confidence: 'high'
          });
          setCalibratingInputLat(false);
        }).catch((err: unknown) => {
          setInputLatCal({ error: String(err instanceof Error ? err.message : err) });
          setCalibratingInputLat(false);
        });
      }, 2000);
    };

    unsubscribed = sync.on(handleSyncEvent);
  }, []);
  useTapeInput({
    active: activeTab === 'TAPE' && !isIpadLayout, dispatch, modeRef, ctrlModeHandlerRef, setClickEnabled,
  });

  // ---------------------------------------------------------------------------
  // window.__tapeTest hook
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const sr = engineRef.current?.sampleRate ?? 44100;
    (window as unknown as Record<string, unknown>).__tapeTest = {
      getState: () => ({
        ready, error, mode, transport,
        tape: {
          activeLane: tape.activeLane,
          clips: tape.lanes[tape.activeLane].clips.map((c) => ({
            id: c.id, tapeStart: c.tapeStart, duration: c.duration,
            tapeStartSecs: c.tapeStart / sr, durationSecs: c.duration / sr, muted: c.muted,
          })),
          tapeLength: tape.tapeLength, playhead: tape.playhead,
          loopIn: tape.loopIn, loopOut: tape.loopOut, loopEnabled: tape.loopEnabled, bpm: tape.bpm, recordingGain: tape.recordingGain,
        },
        clipboard: clipboard ? ('items' in clipboard
          ? { id: 'liftAll', duration: clipboard.items.length }
          : { id: clipboard.id, duration: clipboard.duration }) : null,
        selectedClipId,
        undoDepth: undoStack.length, redoDepth: redoStack.length, lastClipBeats,
        latency: null,
        noteLatency: null,
        sync: { running: syncRunning, bpm: syncBpm, beatPosition: syncBeatPosition },
        selectedAudioDeviceId, selectedMidiInputId, selectedMidiOutputId,
        audioDevices: audioDevices.map((d) => ({ id: d.deviceId, label: d.label })),
        midiInputs, midiOutputs, sessions,
      }),
      injectClip: (durationSecs: number, tapeStartSecs: number) => {
        const sr2 = engineRef.current?.sampleRate ?? 44100;
        const numSamples = Math.round(durationSecs * sr2);
        const synth = new Float32Array(numSamples);
        for (let i = 0; i < numSamples; i++) synth[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / sr2);
        const tapeStart = Math.round(tapeStartSecs * sr2);
        const newClip = finalizeFreeRecording(poolRef.current, synth, tapeStart);
        poolDisplayRef.current = poolRef.current;
        setTape((prev) => {
          const al = prev.activeLane;
          const newClips = applyOverwrite(prev.lanes[al].clips, newClip);
          const newLanes = prev.lanes.map((l, i) => i === al ? { clips: newClips } : l) as [Lane,Lane,Lane,Lane];
          const t = { ...prev, lanes: newLanes, tapeLength: tapeLengthFromLanes(newLanes) };
          tapeRef.current = t;
          engineRef.current?.loadTape(newLanes, poolRef.current);
          return t;
        });
        return newClip.id;
      },
      splitClip: (clipId: string, tapeOffsetSecs: number) => {
        const sr2 = engineRef.current?.sampleRate ?? 44100;
        const tapeOffset = Math.round(tapeOffsetSecs * sr2);
        setTape((prev) => {
          const al = prev.activeLane;
          const newClips = splitClip(prev.lanes[al].clips, clipId, tapeOffset);
          const newLanes = prev.lanes.map((l, i) => i === al ? { clips: newClips } : l) as [Lane,Lane,Lane,Lane];
          const t = { ...prev, lanes: newLanes, tapeLength: tapeLengthFromLanes(newLanes) };
          tapeRef.current = t;
          engineRef.current?.loadTape(newLanes, poolRef.current);
          return t;
        });
      },
      saveSession: (name: string) => saveSession(name, tapeRef.current, poolRef.current, modeRef.current, snapRef.current).then(refreshSessions),
      loadSession: (name: string) => dispatch({ type: 'loadSession', name }),
      listSessions: () => listSessions(),
      OpzControlMode,
    };
  }, [
    ready, error, mode, transport, tape, clipboard,
    undoStack, redoStack, lastClipBeats,
    syncRunning, syncBpm, syncBeatPosition,
    selectedAudioDeviceId, selectedMidiInputId, selectedMidiOutputId,
    audioDevices, midiInputs, midiOutputs, sessions,
    refreshSessions, dispatch,
  ]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  const canEdit = transport === 'idle';
  const hasClips = tape.lanes.some((l) => l.clips.length > 0);
  const sr = engineRef.current?.sampleRate ?? 44100;

  const selectedClipId = clipAtPlayhead(tape.lanes[tape.activeLane].clips, tape.playhead);
  selectedClipIdRef.current = selectedClipId;

  return (
    <div style={{ fontFamily: 'sans-serif', color: '#e4e4e7', background: '#000000', minHeight: '100vh', padding: isIpadLayout && activeTab === 'TAPE' ? 0 : '24px 24px 80px 24px', display: 'block' }}>

      {error && <span style={{ color: '#f87171', fontSize: 13 }}>Error: {error}</span>}

      <div>
        {activeTab === 'COM' && (
        <ComTab
          ready={ready}
          handleInit={() => void handleInit()}
          canEdit={canEdit}
          audioDevices={audioDevices}
          selectedAudioDeviceId={selectedAudioDeviceId}
          handleAudioDeviceChange={(id) => void handleAudioDeviceChange(id)}
          audioOutputDevices={audioOutputDevices}
          selectedAudioOutputId={selectedAudioOutputId}
          handleAudioOutputChange={(id) => void handleAudioOutputChange(id)}
          midiInputs={midiInputs}
          selectedMidiInputId={selectedMidiInputId}
          handleMidiInputChange={handleMidiInputChange}
          midiOutputs={midiOutputs}
          selectedMidiOutputId={selectedMidiOutputId}
          handleMidiOutputChange={handleMidiOutputChange}
          inputLatencyMs={inputLatencyMs}
          setInputLatencyMs={setInputLatencyMs}
          outputLatencyMs={outputLatencyMs}
          setOutputLatencyMs={setOutputLatencyMs}
          midiLatencyMs={midiLatencyMs}
          setMidiLatencyMs={setMidiLatencyMs}
        />
      )}

      {activeTab === 'TAPE' && isIpadLayout && (
        <IpadTapeTab
          ready={ready}
          handleInit={() => void handleInit()}
          tape={tape}
          transport={transport}
          mode={mode}
          snap={snap}
          clickEnabled={clickEnabled}
          canvasRef={canvasRef}
          viewWidthSamplesRef={viewWidthSamplesRef}
          dispatch={dispatch}
          handleToggleClick={handleToggleClick}
          setActiveTab={setActiveTab}
        />
      )}

      {activeTab === 'TAPE' && !isIpadLayout && (
        <TapeTab
          ready={ready}
          handleInit={() => void handleInit()}
          tape={tape}
          transport={transport}
          mode={mode}
          sr={sr}
          hasClips={hasClips}
          syncRunning={syncRunning}
          syncBeatPosition={syncBeatPosition}
          selectedClipId={selectedClipId}
          undoStack={undoStack}
          redoStack={redoStack}
          lastClipBeats={lastClipBeats}
          canvasRef={canvasRef}
          viewWidthSamplesRef={viewWidthSamplesRef}
          handleRecord={() => void handleRecord()}
          handleStop={() => void handleStop()}
          handlePlay={() => void handlePlay()}
          handleSplit={handleSplit}
          handleJoin={handleJoin}
          handleLift={handleLift}
          handleDrop={handleDrop}
          handleUndo={handleUndo}
          handleRedo={handleRedo}
          handleSetLoopIn={handleSetLoopIn}
          handleSetLoopOut={handleSetLoopOut}
          handleToggleLoop={handleToggleLoop}
          handleLoopFromClip={handleLoopFromClip}
          clickEnabled={clickEnabled}
          handleToggleClick={handleToggleClick}
        />
      )}

      {activeTab === 'MIXER' && (
        <MixerTab
          tape={tape}
          handleRecordingGain={handleRecordingGain}
          handleLaneGain={handleLaneGain}
          handleLanePan={handleLanePan}
          handleLaneMute={handleLaneMute}
        />
      )}

      {activeTab === 'PROJ' && (
        <ProjTab
          sessionName={sessionName}
          setSessionName={setSessionName}
          sessionStatus={sessionStatus}
          sessions={sessions}
          handleSave={() => void handleSave()}
          handleLoad={(name) => void handleLoad(name)}
          handleNew={handleNew}
          handleDeleteSession={(name) => void handleDeleteSession(name)}
        />
      )}

      {activeTab === 'TEST' && (
        <TestTab
          ready={ready}
          handleInit={() => void handleInit()}
          canEdit={true}
          selectedMidiOutputId={selectedMidiOutputId}
          latency={null}
          noteLatency={null}
          viewWidthSamplesRef={viewWidthSamplesRef}
          activityLogRef={activityLogRef}
          forceLogUpdate={forceLogUpdate}
          handleLatencyTest={() => {}}
          handleOpZLatencyTest={() => {}}
          handleSendTestNote={() => {}}
          handleSendMidiStart={() => {}}
          handleSendMidiStop={() => {}}
          handleMidiStartToNoteTest={handleMidiStartToNoteTest}
          midiStartToNoteOffset={midiStartToNoteOffset}
          testingMidiStartToNote={testingMidiStartToNote}
          midiLatencyMs={midiLatencyMs}
          setMidiLatencyMs={(ms) => {
            setMidiLatencyMs(ms);
            if (syncEngineRef.current) syncEngineRef.current.midiLatencyMs = ms;
          }}
          inputLatencyMs={inputLatencyMs}
          inputLatCal={inputLatCal}
          calibratingInputLat={calibratingInputLat}
          onCalibrateInputLat={handleCalibrateInputLatency}
          outputLatencyMs={outputLatencyMs}
          setOutputLatencyMs={setOutputLatencyMs}
        />
      )}
      </div>

      {!(isIpadLayout && activeTab === 'TAPE') && <div style={{ position: 'fixed', bottom: 0, left: 0, right: 0, display: 'flex', gap: 2, justifyContent: 'center', padding: '8px 24px', background: '#000000', borderTop: '1px solid #27272a' }}>
        {(['TAPE', 'MIXER', 'PROJ', 'COM', 'TEST'] as const).map((tab) => (
          <button key={tab} onClick={() => setActiveTab(tab)} style={{
            ...btnStyle,
            background: activeTab === tab ? '#3730a3' : '#27272a',
            borderColor: activeTab === tab ? '#4f46e5' : '#3f3f46',
            fontWeight: activeTab === tab ? 600 : 400,
          }}>{tab}</button>
        ))}
      </div>}

    </div>
  );
}
