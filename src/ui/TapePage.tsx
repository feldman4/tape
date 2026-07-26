// TapePage — four-lane tape recorder with tabbed UI.
import { useCallback, useEffect, useRef, useState } from 'react';
import { AudioEngine } from '../audio/audioEngine';
import { AudioPool } from '../audio/audioPool';
import { measureLatency, type LatencyResult } from '../audio/latencyTest';
import { measureNoteLatency, type NoteLatencyResult } from '../audio/onsetDetect';
import { SyncEngine, type SyncEvent } from '../sync/syncEngine';
import { OpzControlMode, type ControlEvent } from '../sync/opzControlMode';
import { makeDefaultTape, LANE_COUNT, type Clip, type Lane, type Tape } from '../tape/model';
import { finalizeFreeRecording, finalizeLoopRecording, finalizeSyncRecording } from '../tape/recording';
import { createClickWaveform } from '../audio/clickWaveform';
import {
  dropClip,
  joinClips,
  liftClip,
  moveClip,
  splitClip,
  applyOverwrite,
  tapeLengthFromLanes,
} from '../tape/editEngine';
import { deleteSession, listSessions, loadSession, saveSession } from '../tape/session';
import {
  drawTimeline,
  laneRowHeight,
  pixelToTape,
  tapeToPixel,
  TIME_AXIS_HEIGHT,
  type TimelineLayout,
} from './renderers/TimelineRenderer';

// OP-Z defaults
const OPZ_PERCUSSION_CHANNEL = 0;
const OPZ_TEST_NOTE = 60;

// Canvas dimensions — 620px ≈ just under half a 13" MacBook Air display (1280 CSS px).
const CANVAS_WIDTH = 620;
const CANVAS_HEIGHT = 200;

// Default zoom: samples per pixel. 20 s visible at 44100 Hz across 900 px.
const DEFAULT_SAMPLES_PER_PIXEL = Math.round((20 * 44100) / CANVAS_WIDTH);

type Mode = 'free' | 'sync';
type TransportState = 'idle' | 'armed' | 'counting-in' | 'recording' | 'playing';

// ---------------------------------------------------------------------------
// Undo helpers
// ---------------------------------------------------------------------------
interface UndoEntry {
  lanes: [Lane, Lane, Lane, Lane];
  loopIn: number;
  loopOut: number;
  loopEnabled: boolean;
}

function snapshotTape(tape: Tape): UndoEntry {
  return { lanes: tape.lanes, loopIn: tape.loopIn, loopOut: tape.loopOut, loopEnabled: tape.loopEnabled };
}

// ---------------------------------------------------------------------------
// Drag state
// ---------------------------------------------------------------------------
interface DragState {
  clipId: string;
  startPx: number;
  origTapeStart: number;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export function TapePage() {
  const engineRef = useRef<AudioEngine | null>(null);
  const syncEngineRef = useRef<SyncEngine | null>(null);
  const ctrlModeRef = useRef<OpzControlMode | null>(null);
  // Updated every render so the OpzControlMode callback always calls the
  // latest versions of handleRecord, handlePlay, etc. (same pattern as addLogFnRef).
  const ctrlModeHandlerRef = useRef<((event: ControlEvent) => void) | null>(null);
  const poolRef = useRef(new AudioPool());
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Audio & MIDI device state
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

  // Tape & transport state
  const [tape, setTape] = useState<Tape>(makeDefaultTape());
  const [transport, setTransport] = useState<TransportState>('idle');
  const [mode, setMode] = useState<Mode>('sync');
  const modeRef = useRef<Mode>('sync');
  useEffect(() => { modeRef.current = mode; }, [mode]);

  const [snap, setSnap] = useState(true);
  const snapRef = useRef(true);
  useEffect(() => { snapRef.current = snap; }, [snap]);

  // Editing state — selectedClipId is derived from playhead, not stored in state.
  const [clipboard, setClipboard] = useState<Clip | null>(null);
  const [undoStack, setUndoStack] = useState<UndoEntry[]>([]);
  const [redoStack, setRedoStack] = useState<UndoEntry[]>([]);

  // UI tab
  const [activeTab, setActiveTab] = useState<'COM'|'TAPE'|'MIXER'|'PROJ'|'TEST'>('TAPE');

  // Sync engine UI state
  const [syncBpm, setSyncBpm] = useState(120);
  const [syncRunning, setSyncRunning] = useState(false);
  const [syncBeatPosition, setSyncBeatPosition] = useState(0);
  const [lastClipBeats, setLastClipBeats] = useState<number | null>(null);

  // Session state
  const [sessions, setSessions] = useState<string[]>([]);
  const [sessionName, setSessionName] = useState('');
  const [sessionStatus, setSessionStatus] = useState('');

  // Test state
  const [latency, setLatency] = useState<LatencyResult | null>(null);
  const [noteLatency, setNoteLatency] = useState<NoteLatencyResult | null>(null);

  // Output latency compensation for Free mode (ms). Clips are shifted back by
  // this amount to account for the time between the worklet generating audio
  // and the user hearing it through speakers.
  const [outputLatencyMs, setOutputLatencyMs] = useState(20);
  const outputLatencyMsRef = useRef(20);
  outputLatencyMsRef.current = outputLatencyMs;

  // Refs for real-time values (avoid stale closures in rAF loop)
  const tapeRef = useRef<Tape>(tape);
  tapeRef.current = tape;
  // transportRef mirrors transport state synchronously so that async callbacks
  // (MIDI event handlers, worklet onPlayhead) always read the current value
  // without waiting for a React re-render.
  const transportRef = useRef<TransportState>(transport);
  transportRef.current = transport;
  const poolDisplayRef = useRef<AudioPool>(poolRef.current);

  // Tracks tape position at start of recording
  const tapeStartForRecordingRef = useRef(0);
  const recordStartWallTimeRef = useRef(0); // Date.now() when recording began
  const loopRotateTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loopRotatingRef = useRef(false); // true while per-pass loop rotation is active
  const armedRef = useRef(false);
  // MIDI clock pulses received since the last Start. BPM is not written to the
  // tape until this exceeds MIN_BPM_STABLE_CLOCKS so early jitter is ignored.
  const clocksSinceStartRef = useRef(0);
  const MIN_BPM_STABLE_CLOCKS = 48; // ~2 beats at 120 BPM ≈ 1 second warmup
  // Cancels a running count-in (stops scheduled clicks, aborts the timeout).
  const cancelCountInRef = useRef<(() => void) | null>(null);

  // Drag state
  const dragRef = useRef<DragState | null>(null);
  // Selected clip is whichever clip contains the current playhead (OP-1F style).
  const selectedClipIdRef = useRef<string | null>(null);

  // Zoom: samples per pixel (centred-playhead viewport; tape scrolls past fixed centre line)
  const samplesPerPixelRef = useRef(DEFAULT_SAMPLES_PER_PIXEL);

  // ---------------------------------------------------------------------------
  // Activity log — written from any callback without triggering re-renders per
  // entry; a force-update counter re-renders the panel after each write.
  // ---------------------------------------------------------------------------
  const activityLogRef = useRef<string[]>([]);
  const [, forceLogUpdate] = useState(0);
  // Stable ref so the handleInit closure (no deps) can always reach addLog.
  const addLogFnRef = useRef<(msg: string) => void>(() => {});
  const addLog = useCallback((msg: string) => {
    const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
    activityLogRef.current = [...activityLogRef.current.slice(-199), `${ts}  ${msg}`];
    forceLogUpdate((v) => v + 1);
  }, []);
  addLogFnRef.current = addLog;

  // getLayout reads refs, so it's always current without needing deps.
  const getLayout = useCallback((): TimelineLayout => ({
    canvasWidth: CANVAS_WIDTH,
    canvasHeight: CANVAS_HEIGHT,
    playhead: tapeRef.current.playhead,
    samplesPerPixel: samplesPerPixelRef.current,
  }), []);

  // Prefers OP-Z device, falls back to first.
  const preferOpZ = <T,>(items: T[], getLabel: (item: T) => string | null): T | undefined =>
    items.find((item) => getLabel(item)?.toLowerCase().includes('op-z')) ?? items[0];

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------
  const handleInit = useCallback(async (opts?: { silent?: boolean }) => {
    try {
      const engine = new AudioEngine();
      await engine.init();
      engineRef.current = engine;
      poolDisplayRef.current = poolRef.current;

      const devices = await engine.listInputDevices();
      setAudioDevices(devices);
      const defaultDevice = preferOpZ(devices, (d) => d.label);
      if (defaultDevice && defaultDevice.deviceId !== engine.inputDeviceId) {
        await engine.setInputDevice(defaultDevice.deviceId);
      }
      setSelectedAudioDeviceId(defaultDevice?.deviceId ?? engine.inputDeviceId ?? null);

      const outputDevices = await engine.listOutputDevices();
      setAudioOutputDevices(outputDevices);
      setSelectedAudioOutputId(engine.outputDeviceId);

      const syncEngine = new SyncEngine(engine.audioContext);
      await syncEngine.init();
      syncEngineRef.current = syncEngine;

      const inputs = syncEngine.listInputs();
      setMidiInputs(inputs);
      const defaultInput = preferOpZ(inputs, (i) => i.name);
      if (defaultInput) { syncEngine.setInputDevice(defaultInput.id); setSelectedMidiInputId(defaultInput.id); }

      const outputs = syncEngine.listOutputs();
      setMidiOutputs(outputs);
      const defaultOutput = preferOpZ(outputs, (o) => o.name);
      if (defaultOutput) { syncEngine.setOutputDevice(defaultOutput.id); setSelectedMidiOutputId(defaultOutput.id); }

      const midiAccess = syncEngine.getMIDIAccess();
      if (midiAccess) {
        // Dispose any previous instance (StrictMode or re-init) before creating a new one.
        ctrlModeRef.current?.dispose();
        const ctrlMode = new OpzControlMode(midiAccess);
        ctrlMode.setInputDevice(defaultInput?.id ?? 'all');
        if (defaultOutput) ctrlMode.setOutputDevice(defaultOutput.id);
        ctrlMode.on((event) => ctrlModeHandlerRef.current?.(event));
        ctrlModeRef.current = ctrlMode;
      }

      syncEngine.on((event: SyncEvent) => {
        if (event.type === 'start') {
          setSyncRunning(true);
          clocksSinceStartRef.current = 0;
          if (armedRef.current && modeRef.current === 'sync') {
            armedRef.current = false;
            const armTape = tapeRef.current;
            tapeStartForRecordingRef.current = armTape.playhead;
            recordStartWallTimeRef.current = Date.now();
            // Load all existing clips so other lanes play back while recording.
            engine.loadTape(armTape.lanes, poolRef.current);
            engine.play(armTape.playhead, { loopIn: armTape.loopIn, loopOut: armTape.loopOut, loopEnabled: armTape.loopEnabled });
            engine.startRecording();
            // Update ref synchronously — setTransport schedules a React re-render
            // asynchronously, so transportRef.current would still read 'armed' if
            // handleStop is called before the next render (e.g. user clicks Stop
            // immediately after OP-Z triggers recording).
            transportRef.current = 'recording';
            setTransport('recording');
          }
        } else if (event.type === 'stop') {
          setSyncRunning(false);
        } else if (event.type === 'clock') {
          clocksSinceStartRef.current += 1;
          setSyncBpm(event.bpm);
          setSyncBeatPosition(event.beatPosition);
          if (clocksSinceStartRef.current >= MIN_BPM_STABLE_CLOCKS) {
            const roundedBpm = Math.round(event.bpm);
            if (roundedBpm !== tapeRef.current.bpm) {
              setTape((prev) => {
                const t = { ...prev, bpm: roundedBpm };
                tapeRef.current = t;
                return t;
              });
            }
          }
        }
      });

      let wasPlayingWorklet = false;
      engine.onPlayhead(({ tapePosition, playing }) => {
        const engineSr = engine.sampleRate;
        // Log playback-state transitions (not every frame — only on edge).
        if (playing && !wasPlayingWorklet) {
          addLogFnRef.current(`▶ worklet: started  tape=${(tapePosition / engineSr).toFixed(3)}s`);
        } else if (!playing && wasPlayingWorklet) {
          addLogFnRef.current(`⏹ worklet: stopped  tape=${(tapePosition / engineSr).toFixed(3)}s  transportRef=${transportRef.current}`);
          // Natural end of clip (or stop-playback confirmed by worklet).
          // Only reset transport if it is currently 'playing' — during 'recording'
          // the worklet plays back other lanes but recording continues independently;
          // do NOT auto-stop the transport when that playback ends naturally.
          if (transportRef.current === 'playing') {
            setTransport('idle');
          }
        }
        wasPlayingWorklet = playing;
        // Only update the tape playhead from the worklet during active playback.
        // During idle/recording/armed the UI manages the playhead itself, and the
        // worklet reports stale values (its internal tapeStart, often 0).
        if (playing) {
          setTape((prev) => ({ ...prev, playhead: tapePosition }));
        }
      });

      const names = await listSessions();
      setSessions(names);

      // Auto-load "init" session if it exists.
      if (names.includes('init')) {
        const result = await loadSession('init');
        if (result) {
          poolRef.current = result.pool;
          setTape(result.tape);
          tapeRef.current = result.tape;
          poolDisplayRef.current = result.pool;
          engineRef.current?.loadTape(result.tape.lanes, result.pool);
          setMode(result.mode);
          setSnap(result.snap);
          setSessionName('init');
        }
      }

      setReady(true);
    } catch (err) {
      if (!opts?.silent) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  }, []);

  // Auto-init on mount when mic permission is already granted.
  // AudioContext.resume() succeeds if the page has had prior user interaction.
  useEffect(() => {
    navigator.permissions
      .query({ name: 'microphone' as PermissionName })
      .then((status) => {
        if (status.state === 'granted') void handleInit({ silent: true });
      })
      .catch(() => { /* permissions API unavailable — keep the button */ });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // run once; handleInit is stable (no deps in its useCallback)

  // ---------------------------------------------------------------------------
  // Render loop — runs at display refresh rate; computes live playhead
  // during recording from wall-clock time (avoids React setState at 60 fps).
  // ---------------------------------------------------------------------------
  useEffect(() => {
    let raf = 0;
    const render = () => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (ctx && canvas) {
        let displayTape = tapeRef.current;
        if (transportRef.current === 'recording') {
          const sr = engineRef.current?.sampleRate ?? 44100;
          const elapsed = Math.round((Date.now() - recordStartWallTimeRef.current) / 1000 * sr);
          const { loopEnabled, loopIn, loopOut } = displayTape;
          const looping = loopEnabled && loopOut > loopIn;
          // Compute linear tape position first, then wrap once we're past loopIn.
          const linearPos = tapeStartForRecordingRef.current + elapsed;
          const displayPlayhead = looping && linearPos >= loopIn
            ? loopIn + (linearPos - loopIn) % (loopOut - loopIn)
            : linearPos;
          displayTape = { ...displayTape, playhead: displayPlayhead };
        }
        const layout: TimelineLayout = {
          canvasWidth: CANVAS_WIDTH,
          canvasHeight: CANVAS_HEIGHT,
          playhead: displayTape.playhead,
          samplesPerPixel: samplesPerPixelRef.current,
        };
        // Derive selection from active lane clips at displayTape.playhead.
        const activeClips = displayTape.lanes[displayTape.activeLane].clips;
        const matches = activeClips.filter(
          (c) => displayTape.playhead >= c.tapeStart && displayTape.playhead < c.tapeStart + c.duration
        );
        const currentSelectedId = matches.length === 0 ? null
          : matches.reduce((a, b) => b.tapeStart > a.tapeStart ? b : a).id;
        drawTimeline(ctx, displayTape, poolDisplayRef.current, layout, currentSelectedId, modeRef.current === 'sync');
      }
      raf = requestAnimationFrame(render);
    };
    raf = requestAnimationFrame(render);
    return () => cancelAnimationFrame(raf);
  }, []);

  // ---------------------------------------------------------------------------
  // Undo helpers
  // ---------------------------------------------------------------------------
  const pushUndo = useCallback((currentTape: Tape) => {
    setUndoStack((prev) => [...prev, snapshotTape(currentTape)]);
    setRedoStack([]);
  }, []);

  const applyEdit = useCallback(
    (currentTape: Tape, newClips: Clip[], extra?: Partial<Tape>): Tape => {
      pushUndo(currentTape);
      const newLanes = currentTape.lanes.map((l, i) =>
        i === currentTape.activeLane ? { ...l, clips: newClips } : l
      ) as [Lane, Lane, Lane, Lane];
      const newTape: Tape = {
        ...currentTape,
        ...(extra ?? {}),
        lanes: newLanes,
        tapeLength: tapeLengthFromLanes(newLanes),
      };
      setTape(newTape);
      tapeRef.current = newTape;
      engineRef.current?.loadTape(newLanes, poolRef.current);
      return newTape;
    },
    [pushUndo],
  );

  const handleUndo = useCallback(() => {
    setUndoStack((prev) => {
      if (prev.length === 0) return prev;
      const entry = prev[prev.length - 1]!;
      setRedoStack((r) => [...r, snapshotTape(tapeRef.current)]);
      const newTape: Tape = {
        ...tapeRef.current,
        lanes: entry.lanes,
        tapeLength: tapeLengthFromLanes(entry.lanes),
        loopIn: entry.loopIn,
        loopOut: entry.loopOut,
        loopEnabled: entry.loopEnabled,
      };
      setTape(newTape);
      tapeRef.current = newTape;
      engineRef.current?.loadTape(entry.lanes, poolRef.current);
      return prev.slice(0, -1);
    });
  }, []);

  const handleRedo = useCallback(() => {
    setRedoStack((prev) => {
      if (prev.length === 0) return prev;
      const entry = prev[prev.length - 1]!;
      setUndoStack((u) => [...u, snapshotTape(tapeRef.current)]);
      const newTape: Tape = {
        ...tapeRef.current,
        lanes: entry.lanes,
        tapeLength: tapeLengthFromLanes(entry.lanes),
        loopIn: entry.loopIn,
        loopOut: entry.loopOut,
        loopEnabled: entry.loopEnabled,
      };
      setTape(newTape);
      tapeRef.current = newTape;
      engineRef.current?.loadTape(entry.lanes, poolRef.current);
      return prev.slice(0, -1);
    });
  }, []);

  // ---------------------------------------------------------------------------
  // Mixer — per-lane gain, pan, mute
  // ---------------------------------------------------------------------------
  const handleLaneGain = useCallback((laneIndex: 0|1|2|3, gain: number) => {
    setTape((prev) => {
      const newLanes = prev.lanes.map((l, i) => i === laneIndex ? { ...l, gain } : l) as [Lane,Lane,Lane,Lane];
      const t = { ...prev, lanes: newLanes };
      tapeRef.current = t;
      engineRef.current?.loadTape(newLanes, poolRef.current);
      return t;
    });
  }, []);

  const handleLanePan = useCallback((laneIndex: 0|1|2|3, pan: number) => {
    setTape((prev) => {
      const newLanes = prev.lanes.map((l, i) => i === laneIndex ? { ...l, pan } : l) as [Lane,Lane,Lane,Lane];
      const t = { ...prev, lanes: newLanes };
      tapeRef.current = t;
      engineRef.current?.loadTape(newLanes, poolRef.current);
      return t;
    });
  }, []);

  const handleLaneMute = useCallback((laneIndex: 0|1|2|3) => {
    setTape((prev) => {
      const newLanes = prev.lanes.map((l, i) => i === laneIndex ? { ...l, muted: !l.muted } : l) as [Lane,Lane,Lane,Lane];
      const t = { ...prev, lanes: newLanes };
      tapeRef.current = t;
      engineRef.current?.loadTape(newLanes, poolRef.current);
      return t;
    });
  }, []);

  // ---------------------------------------------------------------------------
  // Transport
  // ---------------------------------------------------------------------------

  /**
   * Finalize the current recording take: stop capturing, process samples, and
   * add the resulting clip to the active lane via applyEdit.
   * Does NOT stop playback or change transport state — caller handles that.
   */
  const finalizeRecordingTake = useCallback(async (engine: AudioEngine): Promise<void> => {
    // Cancel any pending per-pass rotation before stopping the engine.
    if (loopRotateTimeoutRef.current !== null) {
      clearTimeout(loopRotateTimeoutRef.current);
      loopRotateTimeoutRef.current = null;
    }
    const wasLoopRotating = loopRotatingRef.current;
    loopRotatingRef.current = false;

    const recording = await engine.stopRecording();
    const tapeStart = tapeStartForRecordingRef.current;
    const sr = engine.sampleRate;
    let newClip: Clip;

    // Capture existing clips before finalization — used for overdub (free mode)
    // and for applyOverwrite (both modes).
    const existingClips = tapeRef.current.lanes[tapeRef.current.activeLane].clips;

    if (mode === 'free') {
      const currentTape = tapeRef.current;
      const loopLen = currentTape.loopOut - currentTape.loopIn;
      const outputLatencySamples = Math.round(outputLatencyMsRef.current * sr / 1000);
      const adjustedTapeStart = Math.max(0, tapeStart - outputLatencySamples);

      if (wasLoopRotating) {
        // Per-pass mode: this is the last (possibly partial) pass after the most
        // recent rotation. Finalize it as a plain free recording.
        if (recording.samples.length === 0) {
          // Nothing recorded in the tail — nothing to do.
          return;
        }
        newClip = finalizeFreeRecording(poolRef.current, recording.samples, adjustedTapeStart, existingClips);
        addLog(`✓ Take (loop-rotate tail): ${(recording.samples.length / sr).toFixed(3)}s`);
      } else if (currentTape.loopEnabled && loopLen > 0) {
        // Legacy single-take loop recording (loop too short to rotate or
        // rotation not started). Fold all passes into one clip.
        newClip = finalizeLoopRecording(poolRef.current, recording.samples, adjustedTapeStart, currentTape.loopIn, currentTape.loopOut, existingClips);
        const passes = (recording.samples.length - Math.max(0, currentTape.loopIn - adjustedTapeStart)) / loopLen;
        addLog(`✓ Take (loop-overdub): ${(recording.samples.length / sr).toFixed(3)}s raw, ${passes.toFixed(2)}x passes  latency-adj=${outputLatencyMsRef.current.toFixed(1)}ms`);
      } else {
        newClip = finalizeFreeRecording(poolRef.current, recording.samples, adjustedTapeStart, existingClips);
        addLog(`✓ Take (free): ${(recording.samples.length / sr).toFixed(3)}s  latency-adj=${outputLatencyMsRef.current.toFixed(1)}ms`);
      }
      setLastClipBeats(null);
    } else {
      const currentTape = tapeRef.current;
      const loopLen = currentTape.loopOut - currentTape.loopIn;
      const isLoopRec = currentTape.loopEnabled && loopLen > 0;
      if (isLoopRec) {
        newClip = finalizeLoopRecording(poolRef.current, recording.samples, tapeStart, currentTape.loopIn, currentTape.loopOut);
        const passes = (recording.samples.length - Math.max(0, currentTape.loopIn - tapeStart)) / loopLen;
        addLog(`✓ Take (sync+loop): ${(recording.samples.length / sr).toFixed(3)}s raw, ${passes.toFixed(2)}x passes`);
        setLastClipBeats(null);
      } else {
        const syncEngine = syncEngineRef.current;
        const samplesPerBeat = syncEngine?.samplesPerBeat() ?? sr;
        const beatsElapsed = Math.round(recording.samples.length / samplesPerBeat);
        newClip = finalizeSyncRecording(poolRef.current, recording.samples, tapeStart, beatsElapsed, samplesPerBeat);
        const rawSamples = recording.samples.length;
        const targetSamples = Math.max(0, Math.round(beatsElapsed * samplesPerBeat));
        const corrSamples = targetSamples - rawSamples;
        addLog(`✓ Take (sync): raw=${(rawSamples / sr).toFixed(3)}s  correction=${(corrSamples / sr * 1000).toFixed(1)}ms  beats=${beatsElapsed}`);
        setLastClipBeats(beatsElapsed);
      }
    }

    poolDisplayRef.current = poolRef.current;
    const newClips = applyOverwrite(existingClips, newClip);
    applyEdit(tapeRef.current, newClips);
  }, [mode, applyEdit, addLog]);

  const handleRecord = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine) return;
    const currentTransport = transportRef.current;
    addLog(`⏺ Record  transport=${currentTransport}  mode=${mode}`);

    if (currentTransport === 'recording') {
      // Toggle recording OFF — finalize clip, keep playback running.
      await finalizeRecordingTake(engine);
      transportRef.current = 'playing';
      setTransport('playing');
      return;
    }

    if (currentTransport === 'counting-in') {
      // Cancel count-in, disarm.
      cancelCountInRef.current?.();
      armedRef.current = false;
      transportRef.current = 'idle';
      setTransport('idle');
      addLog('→ count-in cancelled');
      return;
    }

    if (currentTransport === 'playing') {
      // Toggle recording ON during active playback — no new play() needed.
      const currentTape = tapeRef.current;
      tapeStartForRecordingRef.current = currentTape.playhead;
      recordStartWallTimeRef.current = Date.now();
      engine.startRecording();
      // Per-pass loop overdub during playback-then-record.
      if (mode === 'free' && currentTape.loopEnabled && currentTape.loopOut > currentTape.loopIn) {
        loopRotatingRef.current = true;
        const sr0 = engine.sampleRate;
        const firstWall = Date.now() + Math.max(0, (currentTape.loopOut - currentTape.playhead) / sr0 * 1000);
        const doRotation2 = async (passStart: number, wallTime: number) => {
          loopRotateTimeoutRef.current = setTimeout(async () => {
            if (transportRef.current !== 'recording' || modeRef.current !== 'free') return;
            const eng = engineRef.current;
            if (!eng) return;
            const { loopIn, loopOut } = tapeRef.current;
            const sr2 = eng.sampleRate;
            const latSamples = Math.round(outputLatencyMsRef.current * sr2 / 1000);
            const adjStart = Math.max(0, passStart - latSamples);
            const rec = await eng.rotateRecording();
            if (rec.samples.length > 0) {
              const existing = tapeRef.current.lanes[tapeRef.current.activeLane].clips;
              const clip = finalizeFreeRecording(poolRef.current, rec.samples, adjStart, existing);
              poolDisplayRef.current = poolRef.current;
              const newClips = applyOverwrite(existing, clip);
              applyEdit(tapeRef.current, newClips);
              addLog(`↻ Loop pass: ${(rec.samples.length / sr2).toFixed(3)}s`);
            }
            tapeStartForRecordingRef.current = loopIn;
            doRotation2(loopIn, wallTime + (loopOut - loopIn) / sr2 * 1000);
          }, Math.max(0, wallTime - Date.now()));
        };
        doRotation2(currentTape.playhead, firstWall);
      }
      transportRef.current = 'recording';
      setTransport('recording');
      addLog(`⏺ Recording started at ${(currentTape.playhead / engine.sampleRate).toFixed(3)}s`);
      return;
      // Second press cancels arm.
      armedRef.current = false;
      transportRef.current = 'idle';
      setTransport('idle');
      addLog('→ arm cancelled');
      return;
    }

    // idle → arm (free) or arm for MIDI clock (sync)
    if (mode === 'free') {
      armedRef.current = true;
      transportRef.current = 'armed';
      setTransport('armed');
      addLog('⏺ Armed (free) — press Play to record, Shift+Play for count-in');
    } else {
      armedRef.current = true;
      setTransport('armed');
    }
  }, [mode, addLog, finalizeRecordingTake]);

  const handleStop = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine) return;
    const currentTransport = transportRef.current;
    addLog(`⏹ Stop  transport=${currentTransport}`);

    if (currentTransport === 'idle') {
      // Rewind to tape start, or loop in if loop is active
      const currentTape = tapeRef.current;
      const rewindPos = currentTape.loopEnabled ? currentTape.loopIn : 0;
      setTape((prev) => { const t = { ...prev, playhead: rewindPos }; tapeRef.current = t; return t; });
      addLog(`⏮ Rewind to ${(rewindPos / engine.sampleRate).toFixed(3)}s`);
      return;
    }
    if (currentTransport === 'playing') {
      engine.stopPlayback();
      setTransport('idle');
      addLog('⏸ Pause');
      return;
    }
    if (currentTransport === 'armed') {
      armedRef.current = false;
      setTransport('idle');
      return;
    }
    if (currentTransport === 'counting-in') {
      cancelCountInRef.current?.();
      armedRef.current = false;
      transportRef.current = 'idle';
      setTransport('idle');
      return;
    }
    if (currentTransport === 'recording') {
      engine.stopPlayback();
      await finalizeRecordingTake(engine);
      setTransport('idle');
    }
  }, [applyEdit, addLog, finalizeRecordingTake]);

  const handlePlay = useCallback(async (withCountIn = false) => {
    const engine = engineRef.current;
    if (!engine) return;
    const currentTransport = transportRef.current;

    if (currentTransport === 'recording') {
      // Finalize current take, stop playback, re-arm for next pass.
      await finalizeRecordingTake(engine);
      engine.stopPlayback();
      armedRef.current = true;
      transportRef.current = 'armed';
      setTransport('armed');
      addLog('⏺ Take finalized — re-armed');
      return;
    }

    if (currentTransport === 'playing') {
      // Pause — stop engine, keep playhead position
      engine.stopPlayback();
      setTransport('idle');
      addLog('⏸ Pause');
      return;
    }

    // Free-armed: Play triggers recording (immediately or after count-in).
    if (currentTransport === 'armed' && modeRef.current === 'free') {
      const startPlayAndRecord = () => {
        const currentTape = tapeRef.current;
        armedRef.current = false;
        tapeStartForRecordingRef.current = currentTape.playhead;
        recordStartWallTimeRef.current = Date.now();
        engine.loadTape(currentTape.lanes, poolRef.current);
        engine.play(currentTape.playhead, { loopIn: currentTape.loopIn, loopOut: currentTape.loopOut, loopEnabled: currentTape.loopEnabled });
        engine.startRecording();
        // Per-pass loop overdub: rotate recording buffer at each loop boundary.
        if (currentTape.loopEnabled && currentTape.loopOut > currentTape.loopIn) {
          loopRotatingRef.current = true;
          const sr0 = engine.sampleRate;
          const firstWall = Date.now() + Math.max(0, (currentTape.loopOut - currentTape.playhead) / sr0 * 1000);
          const doRotation = async (passStart: number, wallTime: number) => {
            loopRotateTimeoutRef.current = setTimeout(async () => {
              if (transportRef.current !== 'recording' || modeRef.current !== 'free') return;
              const eng = engineRef.current;
              if (!eng) return;
              const { loopIn, loopOut } = tapeRef.current;
              const sr2 = eng.sampleRate;
              const latSamples = Math.round(outputLatencyMsRef.current * sr2 / 1000);
              const adjStart = Math.max(0, passStart - latSamples);
              const rec = await eng.rotateRecording();
              if (rec.samples.length > 0) {
                const existing = tapeRef.current.lanes[tapeRef.current.activeLane].clips;
                const clip = finalizeFreeRecording(poolRef.current, rec.samples, adjStart, existing);
                poolDisplayRef.current = poolRef.current;
                const newClips = applyOverwrite(existing, clip);
                applyEdit(tapeRef.current, newClips);
                addLog(`↻ Loop pass: ${(rec.samples.length / sr2).toFixed(3)}s`);
              }
              tapeStartForRecordingRef.current = loopIn;
              doRotation(loopIn, wallTime + (loopOut - loopIn) / sr2 * 1000);
            }, Math.max(0, wallTime - Date.now()));
          };
          doRotation(currentTape.playhead, firstWall);
        }
        transportRef.current = 'recording';
        setTransport('recording');
        addLog(`⏺ Recording started at ${(currentTape.playhead / engine.sampleRate).toFixed(3)}s`);
      };

      if (!withCountIn) {
        startPlayAndRecord();
        return;
      }

      // Count-in: schedule 4 metronome clicks then start recording.
      const ctx = engine.audioContext;
      const bpm = tapeRef.current.bpm || 120;
      const beatDuration = 60 / bpm; // seconds
      const clickWaveform = createClickWaveform(ctx.sampleRate);
      const clickBuffer = ctx.createBuffer(1, clickWaveform.length, ctx.sampleRate);
      clickBuffer.copyToChannel(new Float32Array(clickWaveform), 0);

      const nodes: AudioBufferSourceNode[] = [];
      for (let beat = 0; beat < 4; beat++) {
        const node = ctx.createBufferSource();
        node.buffer = clickBuffer;
        // Accent beat 1
        const gainNode = ctx.createGain();
        gainNode.gain.value = beat === 0 ? 1.0 : 0.5;
        node.connect(gainNode);
        gainNode.connect(ctx.destination);
        node.start(ctx.currentTime + beat * beatDuration);
        nodes.push(node);
      }

      let cancelled = false;
      const cancel = () => {
        cancelled = true;
        for (const n of nodes) { try { n.stop(); } catch { /* already ended */ } }
        cancelCountInRef.current = null;
      };
      cancelCountInRef.current = cancel;

      const countInMs = 4 * beatDuration * 1000;
      addLog(`⏺ Count-in: ${bpm.toFixed(0)} BPM, ${(countInMs / 1000).toFixed(2)}s`);
      transportRef.current = 'counting-in';
      setTransport('counting-in');

      setTimeout(() => {
        if (cancelled) return;
        cancelCountInRef.current = null;
        startPlayAndRecord();
      }, countInMs);
      return;
    }

    // Sync-armed: Play button does nothing — recording starts on MIDI clock.
    if (currentTransport === 'armed') return;

    // idle → plain playback (no recording)
    const currentTape = tapeRef.current;
    addLog(`▶ Play  playhead=${(currentTape.playhead / engine.sampleRate).toFixed(3)}s`);
    engine.loadTape(currentTape.lanes, poolRef.current);
    engine.play(currentTape.playhead, {
      loopIn: currentTape.loopIn,
      loopOut: currentTape.loopOut,
      loopEnabled: currentTape.loopEnabled,
    });
    setTransport('playing');
  }, [addLog, mode, finalizeRecordingTake]);

  // ---------------------------------------------------------------------------
  // Seek + drag (canvas interaction)
  // ---------------------------------------------------------------------------
  const handleCanvasMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const layout = getLayout();
    const tapePos = pixelToTape(px, layout);
    const currentTape = tapeRef.current;

    // Determine which lane was clicked from the y coordinate.
    const clickedLane = py < TIME_AXIS_HEIGHT ? -1
      : Math.min(LANE_COUNT - 1, Math.floor((py - TIME_AXIS_HEIGHT) / laneRowHeight(CANVAS_HEIGHT)));

    const hitClip = clickedLane >= 0
      ? currentTape.lanes[clickedLane]!.clips.find((c) => {
          const cx = tapeToPixel(c.tapeStart, layout);
          const cw = tapeToPixel(c.tapeStart + c.duration, layout) - cx;
          return px >= cx && px <= cx + cw;
        })
      : undefined;

    // Clicking a lane (even without a clip) makes it active.
    if (clickedLane >= 0 && clickedLane !== currentTape.activeLane) {
      setTape((prev) => {
        const t = { ...prev, activeLane: clickedLane as 0|1|2|3 };
        tapeRef.current = t;
        return t;
      });
    }

    if (hitClip) {
      // Start drag on the clicked clip.
      dragRef.current = { clipId: hitClip.id, startPx: px, origTapeStart: hitClip.tapeStart };
    } else {
      // Seek: in Sync mode snap to the nearest beat boundary.
      let seekPos = Math.max(0, Math.round(tapePos));
      if (mode === 'sync') {
        const bpm = tapeRef.current.bpm || 120;
        const sr = engineRef.current?.sampleRate ?? 44100;
        const samplesPerBeat = (sr * 60) / bpm;
        seekPos = Math.max(0, Math.round(Math.round(tapePos / samplesPerBeat) * samplesPerBeat));
      }
      setTape((prev) => {
        const t = { ...prev, playhead: seekPos };
        tapeRef.current = t;
        return t;
      });
    }
  }, [getLayout, mode]);

  const handleCanvasMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    // Delta in tape samples = pixel delta * samplesPerPixel (independent of playhead).
    const deltaSamples = Math.round((px - drag.startPx) * samplesPerPixelRef.current);
    const newTapeStart = Math.max(0, drag.origTapeStart + deltaSamples);

    setTape((prev) => {
      const activeLane = prev.activeLane;
      const newClips = moveClip(prev.lanes[activeLane].clips, drag.clipId, newTapeStart);
      const newLanes = prev.lanes.map((l, i) => i === activeLane ? { clips: newClips } : l) as [Lane,Lane,Lane,Lane];
      const t = { ...prev, lanes: newLanes, tapeLength: tapeLengthFromLanes(newLanes) };
      tapeRef.current = t;
      return t;
    });
  }, []);

  const handleCanvasMouseUp = useCallback(() => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    const currentTape = tapeRef.current;
    const movedClip = currentTape.lanes[currentTape.activeLane].clips.find((c) => c.id === drag.clipId);
    if (movedClip && movedClip.tapeStart !== drag.origTapeStart) {
      // Commit the drag as an undoable edit (push the "before" state).
      setUndoStack((prev) => [
        ...prev,
        {
          lanes: currentTape.lanes,
          loopIn: currentTape.loopIn,
          loopOut: currentTape.loopOut,
          loopEnabled: currentTape.loopEnabled,
        },
      ]);
      setRedoStack([]);
      engineRef.current?.loadTape(currentTape.lanes, poolRef.current);
    }
  }, []);

  // ---------------------------------------------------------------------------
  // Edit operations
  // ---------------------------------------------------------------------------
  const handleSplit = useCallback(() => {
    const currentTape = tapeRef.current;
    const sid = selectedClipIdRef.current;
    if (!sid) return;
    const newClips = splitClip(currentTape.lanes[currentTape.activeLane].clips, sid, currentTape.playhead);
    if (newClips !== currentTape.lanes[currentTape.activeLane].clips) applyEdit(currentTape, newClips);
  }, [applyEdit]);

  const handleLift = useCallback(() => {
    const currentTape = tapeRef.current;
    const sid = selectedClipIdRef.current;
    if (!sid) return;
    const { clips: newClips, lifted } = liftClip(currentTape.lanes[currentTape.activeLane].clips, sid);
    if (!lifted) return;
    setClipboard(lifted);
    applyEdit(currentTape, newClips);
  }, [applyEdit]);

  const handleDrop = useCallback(() => {
    if (!clipboard) return;
    const currentTape = tapeRef.current;
    const newClips = dropClip(currentTape.lanes[currentTape.activeLane].clips, clipboard, currentTape.playhead);
    const dropped = newClips[newClips.length - 1]!;
    applyEdit(currentTape, newClips);
    // Seek playhead to end of dropped clip so it auto-selects and is ready to continue.
    setTape((prev) => { const t = { ...prev, playhead: dropped.tapeStart + dropped.duration }; tapeRef.current = t; return t; });
  }, [clipboard, applyEdit]);

  const handleJoin = useCallback(() => {
    const currentTape = tapeRef.current;
    const clips = currentTape.lanes[currentTape.activeLane].clips;
    const sid = selectedClipIdRef.current;
    if (!sid || clips.length < 2) return;
    const selectedIdx = clips.findIndex((c) => c.id === sid);
    if (selectedIdx < 0) return;
    const neighbour = clips[selectedIdx + 1] ?? clips[selectedIdx - 1];
    if (!neighbour) return;
    const { clips: newClips, pool } = joinClips(clips, sid, neighbour.id, poolRef.current);
    poolRef.current = pool;
    poolDisplayRef.current = pool;
    applyEdit(currentTape, newClips);
  }, [applyEdit]);

  // (clip-level mute removed — use lane mute instead)

  // ---------------------------------------------------------------------------
  // Loop operations
  // ---------------------------------------------------------------------------

  /** Pushes updated loop options to the worklet immediately if playback is active. */
  const syncLoopToEngine = useCallback((loopIn: number, loopOut: number, loopEnabled: boolean) => {
    if (transportRef.current === 'playing') {
      engineRef.current?.setLoop({ loopIn, loopOut, loopEnabled });
    }
  }, []);

  const handleSetLoopIn = useCallback(() => {
    const currentTape = tapeRef.current;
    pushUndo(currentTape);
    setTape((prev) => {
      const t = { ...prev, loopIn: prev.playhead };
      tapeRef.current = t;
      return t;
    });
    syncLoopToEngine(currentTape.playhead, currentTape.loopOut, currentTape.loopEnabled);
  }, [pushUndo, syncLoopToEngine]);

  const handleSetLoopOut = useCallback(() => {
    const currentTape = tapeRef.current;
    pushUndo(currentTape);
    setTape((prev) => {
      const t = { ...prev, loopOut: prev.playhead };
      tapeRef.current = t;
      return t;
    });
    syncLoopToEngine(currentTape.loopIn, currentTape.playhead, currentTape.loopEnabled);
  }, [pushUndo, syncLoopToEngine]);

  const handleToggleLoop = useCallback(() => {
    const currentTape = tapeRef.current;
    const sampleRate = engineRef.current?.sampleRate ?? 44100;
    const newEnabled = !currentTape.loopEnabled;
    const fmt = (s: number) => (s / sampleRate).toFixed(2);
    addLog(`⟳ Loop ${newEnabled ? 'on' : 'off'}  in=${fmt(currentTape.loopIn)}s  out=${fmt(currentTape.loopOut)}s`);
    setTape((prev) => {
      const t = { ...prev, loopEnabled: newEnabled };
      tapeRef.current = t;
      return t;
    });
    syncLoopToEngine(currentTape.loopIn, currentTape.loopOut, newEnabled);
  }, [addLog, syncLoopToEngine]);

  const handleLoopFromClip = useCallback(() => {
    const sid = selectedClipIdRef.current;
    if (!sid) return;
    const currentTape = tapeRef.current;
    const clip = currentTape.lanes[currentTape.activeLane].clips.find((c) => c.id === sid);
    if (!clip) return;
    pushUndo(currentTape);
    const loopIn = clip.tapeStart;
    const loopOut = clip.tapeStart + clip.duration;
    setTape((prev) => {
      const t = { ...prev, loopIn, loopOut, loopEnabled: true };
      tapeRef.current = t;
      return t;
    });
    syncLoopToEngine(loopIn, loopOut, true);
  }, [pushUndo, syncLoopToEngine]);

  // ---------------------------------------------------------------------------
  // Session
  // ---------------------------------------------------------------------------
  const refreshSessions = useCallback(async () => {
    const names = await listSessions();
    setSessions(names);
  }, []);

  const handleSave = useCallback(async () => {
    if (!sessionName.trim()) { setSessionStatus('Enter a session name first'); return; }
    try {
      await saveSession(sessionName.trim(), tapeRef.current, poolRef.current, modeRef.current, snapRef.current);
      setSessionStatus(`Saved "${sessionName.trim()}"`);
      await refreshSessions();
    } catch (err) {
      setSessionStatus(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [sessionName, refreshSessions]);

  const handleLoad = useCallback(async (name: string) => {
    if (!name) return;
    try {
      const result = await loadSession(name);
      if (!result) { setSessionStatus(`Session "${name}" not found`); return; }
      poolRef.current = result.pool;
      poolDisplayRef.current = result.pool;
      setTape(result.tape);
      tapeRef.current = result.tape;
      engineRef.current?.loadTape(result.tape.lanes, result.pool);
      setMode(result.mode);
      modeRef.current = result.mode;
      setSnap(result.snap);
      snapRef.current = result.snap;
      setUndoStack([]);
      setRedoStack([]);
      setSessionName(name);
      setSessionStatus(`Loaded "${name}"`);
    } catch (err) {
      setSessionStatus(`Load failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, []);

  const handleNew = useCallback(() => {
    const freshPool = new AudioPool();
    poolRef.current = freshPool;
    poolDisplayRef.current = freshPool;
    const freshTape = makeDefaultTape();
    setTape(freshTape);
    tapeRef.current = freshTape;
    engineRef.current?.loadTape([], freshPool);
    setClipboard(null);
    setUndoStack([]);
    setRedoStack([]);
    setSessionName('');
    setSessionStatus('New session');
  }, []);

  const handleDeleteSession = useCallback(async (name: string) => {
    await deleteSession(name);
    await refreshSessions();
    setSessionStatus(`Deleted "${name}"`);
  }, [refreshSessions]);

  // ---------------------------------------------------------------------------
  // Latency / OP-Z test controls (preserved from Stage 0)
  // ---------------------------------------------------------------------------
  const handleLatencyTest = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.startRecording();
    const clickAtFrame = engine.scheduleClick(0.05);
    await new Promise((r) => setTimeout(r, 700));
    const recording = await engine.stopRecording();
    setLatency(measureLatency(recording.samples, recording.startFrame, clickAtFrame, engine.sampleRate));
  }, []);

  const handleOpZLatencyTest = useCallback(async () => {
    const engine = engineRef.current;
    const syncEngine = syncEngineRef.current;
    if (!engine || !syncEngine) return;
    engine.startRecording();
    const sentFrame = engine.frameForTimeFromNow(0);
    syncEngine.sendNoteOn(OPZ_TEST_NOTE, 100, OPZ_PERCUSSION_CHANNEL);
    await new Promise((r) => setTimeout(r, 150));
    syncEngine.sendNoteOff(OPZ_TEST_NOTE, OPZ_PERCUSSION_CHANNEL);
    await new Promise((r) => setTimeout(r, 550));
    const recording = await engine.stopRecording();
    setNoteLatency(measureNoteLatency(recording.samples, recording.startFrame, sentFrame, engine.sampleRate));
  }, []);

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
    setSelectedMidiOutputId(id);
  }, []);

  // ---------------------------------------------------------------------------
  // OP-Z control mode: update the handler ref every render so the stable
  // OpzControlMode listener always dispatches to the latest callbacks.
  ctrlModeHandlerRef.current = (event: ControlEvent) => {
    switch (event.type) {
      case 'record':     handleRecord(); break;
      case 'play':       handlePlay(event.shift); break;
      case 'stop':       handleStop(); break;
      case 'lift':       handleLift(); break;
      case 'drop':       handleDrop(); break;
      case 'split':      event.shift ? handleJoin() : handleSplit(); break;
      case 'loopIn':     handleSetLoopIn(); break;
      case 'loopOut':    handleSetLoopOut(); break;
      case 'loopToggle': event.shift ? handleLoopFromClip() : handleToggleLoop(); break;
      case 'selectLane': {
        const { lane, shift } = event;
        if (shift) {
          setTape((prev) => {
            const newLanes = prev.lanes.map((l, i) =>
              i === lane ? { ...l, muted: !l.muted } : l
            ) as [Lane, Lane, Lane, Lane];
            const t = { ...prev, lanes: newLanes };
            tapeRef.current = t;
            engineRef.current?.loadTape(newLanes, poolRef.current);
            return t;
          });
          addLog(`◈ Lane ${lane + 1} mute toggled`);
        } else {
          setTape((prev) => { const t = { ...prev, activeLane: lane }; tapeRef.current = t; return t; });
          addLog(`◈ Lane ${lane + 1} selected`);
        }
        break;
      }
      case 'encoderDelta': {
        const { index, delta, shift } = event;
        const currentTape = tapeRef.current;
        const sr2 = engineRef.current?.sampleRate ?? 44100;
        // samplesPerBeat derived from the project BPM (updated from MIDI clock).
        const spb = (sr2 * 60) / currentTape.bpm;

        if (index === 1 && !shift) {
          // Blue encoder, no shift: scrub playhead.
          // Blocked during recording/armed — playhead is managed by the engine.
          if (transportRef.current === 'recording' || transportRef.current === 'armed') break;
          // Snap: step by 1 beat snapped to grid; no snap: 1 px of current zoom.
          const newPlayhead = snapRef.current
            ? Math.max(0, Math.round((Math.round(currentTape.playhead / spb) + delta) * spb))
            : Math.max(0, Math.round(currentTape.playhead + delta * samplesPerPixelRef.current));
          setTape((prev) => { const t = { ...prev, playhead: newPlayhead }; tapeRef.current = t; return t; });
        } else if (index === 1 && shift) {
          // Blue encoder + shift: slide selected clip + playhead by the same amount.
          const sid = selectedClipIdRef.current;
          if (!sid) break;
          const activeLane = currentTape.activeLane;
          const clip = currentTape.lanes[activeLane].clips.find((c) => c.id === sid);
          if (!clip) break;
          const deltaSamples = snapRef.current
            ? Math.round(delta * spb)
            : Math.round(delta * samplesPerPixelRef.current);
          const newTapeStart = Math.max(0, clip.tapeStart + deltaSamples);
          // Clamp so playhead doesn't go negative when clip hits the tape start.
          const actualDelta = newTapeStart - clip.tapeStart;
          const newPlayhead = Math.max(0, currentTape.playhead + actualDelta);
          applyEdit(currentTape, moveClip(currentTape.lanes[activeLane].clips, sid, newTapeStart), { playhead: newPlayhead });
        } else if (index === 0) {
          // Green encoder: adjust loop out (no shift) or loop in (shift).
          // Allowed in all transport states including armed/recording.
          // In sync mode, snap the current value to nearest beat first so delta steps land on grid.
          const cur = shift ? currentTape.loopIn : currentTape.loopOut;
          const newVal = snapRef.current
            ? Math.max(0, Math.round((Math.round(cur / spb) + delta) * spb))
            : Math.max(0, Math.round(cur + delta * samplesPerPixelRef.current));
          const patch = shift ? { loopIn: newVal } : { loopOut: newVal };
          setTape((prev) => { const t = { ...prev, ...patch }; tapeRef.current = t; return t; });
          const newLoopIn  = shift ? newVal : currentTape.loopIn;
          const newLoopOut = shift ? currentTape.loopOut : newVal;
          syncLoopToEngine(newLoopIn, newLoopOut, currentTape.loopEnabled);
          if (snapRef.current) {
            const label = shift ? 'in' : 'out';
            addLog(`loop ${label} → ${(newVal / spb).toFixed(2)} beats  (${(newVal / sr2).toFixed(2)}s)`);
          }
        }
        break;
      }
      // shiftChange: modifier state only, no direct action
    }
  };

  // ---------------------------------------------------------------------------
  // Keyboard shortcuts (TAPE tab only)
  // ---------------------------------------------------------------------------
  // Mirrors the OP-Z channel-15 control surface.
  // Encoder-style controls: hold the key and drag the mouse horizontally.
  //   Q = encoder 2 / blue  (scrub; Shift=slide clip)  W = encoder 1 / green  (loop out/in)
  //   E = encoder 3 / white (reserved)        F = encoder 4 / orange (reserved)
  // Every PX_PER_TICK pixels of horizontal drag emits one encoder delta tick.
  // Hold Shift while dragging to activate the secondary encoder action.
  useEffect(() => {
    if (activeTab !== 'TAPE') return;

    let encoderKey: string | null = null;
    let lastMouseX = 0;
    let accumDx = 0;
    const PX_PER_TICK = 8;

    // Encoder key → ControlEvent encoder index (0-based)
    const ENCODER_KEYS: Record<string, 0 | 1 | 2 | 3> = { q: 1, w: 0, e: 2, f: 3 };

    const isEditable = (t: EventTarget | null) =>
      t instanceof HTMLInputElement ||
      t instanceof HTMLTextAreaElement ||
      t instanceof HTMLSelectElement;

    const onKeyDown = (ev: KeyboardEvent) => {
      if (isEditable(ev.target)) return;
      if (ev.repeat) return;
      if (ev.metaKey || ev.ctrlKey) return; // allow browser shortcuts

      const key = ev.key.toLowerCase();
      const shift = ev.shiftKey;

      if (key in ENCODER_KEYS) {
        encoderKey = key;
        accumDx = 0;
        ev.preventDefault();
        return;
      }

      const ctrl = ctrlModeHandlerRef.current;
      if (!ctrl) return;

      let handled = true;
      switch (ev.key) {
        case '1': case '!': ctrl({ type: 'selectLane', lane: 0, shift }); break;
        case '2': case '@': ctrl({ type: 'selectLane', lane: 1, shift }); break;
        case '3': case '#': ctrl({ type: 'selectLane', lane: 2, shift }); break;
        case '4': case '$': ctrl({ type: 'selectLane', lane: 3, shift }); break;
        case 'r': case 'R': ctrl({ type: 'record', shift }); break;
        case ' ':            ctrl({ type: 'play',   shift }); break;
        case 'Escape':       ctrl({ type: 'stop',   shift: false }); break;
        case '[':            ctrl({ type: 'loopIn'  }); break;
        case ']':            ctrl({ type: 'loopOut' }); break;
        case '\\':           ctrl({ type: 'loopToggle', shift }); break;
        case 'l': case 'L': ctrl({ type: 'lift',  shift }); break;
        case 'd': case 'D': ctrl({ type: 'drop',  shift }); break;
        case 'z': case 'Z': if (transportRef.current !== 'playing' && transportRef.current !== 'recording') setMode((m) => m === 'sync' ? 'free' : 'sync'); break;
        case 'x': case 'X': setSnap((s) => !s); break;
        case 's': case 'S': ctrl({ type: 'split', shift }); break;
        default: handled = false;
      }
      if (handled) ev.preventDefault();
    };

    const onKeyUp = (ev: KeyboardEvent) => {
      if (ev.key.toLowerCase() === encoderKey) {
        encoderKey = null;
        accumDx = 0;
      }
    };

    const onMouseMove = (ev: MouseEvent) => {
      const dx = ev.clientX - lastMouseX;
      lastMouseX = ev.clientX;
      if (!encoderKey) return;
      accumDx += dx;
      const ticks = Math.trunc(accumDx / PX_PER_TICK);
      if (ticks !== 0) {
        accumDx -= ticks * PX_PER_TICK;
        const index = ENCODER_KEYS[encoderKey]!;
        ctrlModeHandlerRef.current?.({
          type: 'encoderDelta',
          index,
          delta: ticks,
          shift: ev.shiftKey,
        });
      }
    };

    window.addEventListener('keydown',   onKeyDown);
    window.addEventListener('keyup',     onKeyUp);
    window.addEventListener('mousemove', onMouseMove);
    return () => {
      window.removeEventListener('keydown',   onKeyDown);
      window.removeEventListener('keyup',     onKeyUp);
      window.removeEventListener('mousemove', onMouseMove);
    };
  }, [activeTab]);
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const sr = engineRef.current?.sampleRate ?? 44100;
    (window as unknown as Record<string, unknown>).__tapeTest = {
      getState: () => ({
        ready,
        error,
        mode,
        transport,
        tape: {
          activeLane: tape.activeLane,
          clips: tape.lanes[tape.activeLane].clips.map((c) => ({
            id: c.id,
            tapeStart: c.tapeStart,
            duration: c.duration,
            tapeStartSecs: c.tapeStart / sr,
            durationSecs: c.duration / sr,
            muted: c.muted,
          })),
          tapeLength: tape.tapeLength,
          playhead: tape.playhead,
          loopIn: tape.loopIn,
          loopOut: tape.loopOut,
          loopEnabled: tape.loopEnabled,
          bpm: tape.bpm,
        },
        clipboard: clipboard ? { id: clipboard.id, duration: clipboard.duration } : null,
        selectedClipId,
        undoDepth: undoStack.length,
        redoDepth: redoStack.length,
        lastClipBeats,
        latency: latency ? { latencyMs: latency.latencyMs, confidence: latency.confidence } : null,
        noteLatency: noteLatency ? { latencyMs: noteLatency.latencyMs, index: noteLatency.index } : null,
        sync: { running: syncRunning, bpm: syncBpm, beatPosition: syncBeatPosition },
        selectedAudioDeviceId,
        selectedMidiInputId,
        selectedMidiOutputId,
        audioDevices: audioDevices.map((d) => ({ id: d.deviceId, label: d.label })),
        midiInputs,
        midiOutputs,
        sessions,
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
          const newClips = [...prev.lanes[al].clips, newClip];
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
      loadSession: (name: string) => handleLoad(name),
      listSessions: () => listSessions(),
      // Exposed for control-mode-test.mjs: instantiate with a mock MIDIAccess in the browser.
      OpzControlMode,
    };
  }, [
    ready, error, mode, transport, tape, clipboard,
    undoStack, redoStack, lastClipBeats, latency, noteLatency,
    syncRunning, syncBpm, syncBeatPosition,
    selectedAudioDeviceId, selectedMidiInputId, selectedMidiOutputId,
    audioDevices, midiInputs, midiOutputs, sessions,
    refreshSessions, handleLoad,
  ]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  const canEdit = transport === 'idle';
  const canSwitchMode = transport !== 'playing' && transport !== 'recording';
  const hasClips = tape.lanes.some((l) => l.clips.length > 0);
  const sr = engineRef.current?.sampleRate ?? 44100;
  // Selection follows the playhead within the active lane.
  const selMatches = tape.lanes[tape.activeLane].clips.filter(
    (c) => tape.playhead >= c.tapeStart && tape.playhead < c.tapeStart + c.duration
  );
  const selectedClipId = selMatches.length === 0 ? null
    : selMatches.reduce((a, b) => b.tapeStart > a.tapeStart ? b : a).id;
  selectedClipIdRef.current = selectedClipId;

  return (
    <div style={{ fontFamily: 'sans-serif', color: '#e4e4e7', background: '#000000', minHeight: '100vh', padding: 24 }}>

      {/* ---- Global header ---- */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 14 }}>
        <h1 style={{ margin: 0, fontSize: 20 }}>Tape</h1>
        <div style={{ display: 'flex', gap: 2 }}>
          {(['TAPE', 'MIXER', 'PROJ', 'COM', 'TEST'] as const).map((tab) => (
            <button key={tab} onClick={() => setActiveTab(tab)} style={{
              ...btnStyle,
              background: activeTab === tab ? '#3730a3' : '#27272a',
              borderColor: activeTab === tab ? '#4f46e5' : '#3f3f46',
              fontWeight: activeTab === tab ? 600 : 400,
            }}>{tab}</button>
          ))}
        </div>
        {error && <span style={{ color: '#f87171', fontSize: 13 }}>Error: {error}</span>}
      </div>

      {/* ================================================================ */}
      {/* COM tab — connections & log                                       */}
      {/* ================================================================ */}
      {activeTab === 'COM' && (
        <>
          {!ready && (
            <button onClick={() => void handleInit()} style={btnStyle}>Enable Audio + MIDI</button>
          )}
          {ready && (
            <>
              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 12 }}>
                <label>Audio in:
                  <select value={selectedAudioDeviceId ?? ''} onChange={(e) => handleAudioDeviceChange(e.target.value)} disabled={!canEdit} style={{ marginLeft: 6 }}>
                    {audioDevices.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || d.deviceId}</option>)}
                  </select>
                </label>
                <label>Audio out:
                  <select value={selectedAudioOutputId} onChange={(e) => void handleAudioOutputChange(e.target.value)} style={{ marginLeft: 6 }}>
                    <option value="">System default</option>
                    {audioOutputDevices.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || d.deviceId}</option>)}
                  </select>
                </label>
                <label>MIDI in:
                  <select value={selectedMidiInputId} onChange={(e) => handleMidiInputChange(e.target.value)} disabled={!canEdit} style={{ marginLeft: 6 }}>
                    <option value="all">All inputs</option>
                    {midiInputs.map((i) => <option key={i.id} value={i.id}>{i.name || i.id}</option>)}
                  </select>
                </label>
                <label>MIDI out:
                  <select value={selectedMidiOutputId ?? ''} onChange={(e) => handleMidiOutputChange(e.target.value)} disabled={!canEdit} style={{ marginLeft: 6 }}>
                    <option value="" disabled>None</option>
                    {midiOutputs.map((o) => <option key={o.id} value={o.id}>{o.name || o.id}</option>)}
                  </select>
                </label>
              </div>
              <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
                <label style={{ fontSize: 13, color: '#a1a1aa', display: 'flex', gap: 6, alignItems: 'center' }}>
                  Output latency
                  <input
                    type="number"
                    min={0}
                    max={500}
                    step={1}
                    value={outputLatencyMs}
                    onChange={(e) => setOutputLatencyMs(Math.max(0, Number(e.target.value)))}
                    style={{ width: 72, padding: '2px 6px', background: '#27272a', border: '1px solid #3f3f46', color: '#e4e4e7', borderRadius: 4, fontSize: 13 }}
                  />
                  <span style={{ color: '#52525b' }}>ms — shifts Free mode clips back to compensate for speaker delay</span>
                </label>
              </div>
            </>
          )}
        </>
      )}

      {/* ================================================================ */}
      {/* TAPE tab — transport, timeline, edit                              */}
      {/* ================================================================ */}
      {activeTab === 'TAPE' && (
        <div style={{ maxWidth: CANVAS_WIDTH, margin: '0 auto' }}>
          {!ready && (
            <button onClick={() => void handleInit()} style={btnStyle}>Enable Audio + MIDI</button>
          )}
          {ready && (
            <>
              {/* Lane selector + status bar */}
              <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginBottom: 6 }}>
                {([0, 1, 2, 3] as const).map((i) => {
                  const isMuted = tape.lanes[i].muted;
                  const isActive = tape.activeLane === i;
                  return (
                    <button key={i}
                      onClick={(e) => {
                        if (e.shiftKey) {
                          handleLaneMute(i);
                        } else {
                          setTape((prev) => { const t = { ...prev, activeLane: i }; tapeRef.current = t; return t; });
                        }
                      }}
                      title={isMuted
                        ? `Lane ${i + 1} — muted (Shift+click, Shift+${i + 1}, or OP-Z Shift+white key to unmute)`
                        : `Lane ${i + 1} — Shift+click, Shift+${i + 1}, or OP-Z Shift+white key to mute`}
                      style={{ ...btnStyle,
                        background: isActive ? '#4338ca' : '#27272a',
                        borderColor: isActive ? '#6366f1' : '#3f3f46',
                        minWidth: 28,
                        fontWeight: isActive ? 600 : 400,
                        opacity: isMuted ? 0.4 : 1,
                        textDecoration: isMuted ? 'line-through' : 'none',
                      }}>
                      {i + 1}
                    </button>
                  );
                })}
                <span style={{ fontSize: 13, color: '#a1a1aa', marginLeft: 10 }}>
                  {transport} | {(tape.playhead / sr).toFixed(2)}s
                </span>
                <span style={{ fontSize: 14, color: '#e4e4e7', marginLeft: 10, fontVariantNumeric: 'tabular-nums' }}>
                  {tape.bpm} BPM
                </span>
                <span style={{ fontSize: 12, color: '#a1a1aa', marginLeft: 10 }}>
                  MIDI: {syncRunning ? `▶ ${syncBeatPosition.toFixed(1)}` : 'stopped'}
                </span>
              </div>

              {/* Mode + Snap */}
              <div style={{ marginBottom: 6, display: 'flex', gap: 16, alignItems: 'center' }}>
                <label><input type="radio" checked={mode === 'free'} onChange={() => setMode('free')} disabled={!canSwitchMode} />{' '}Free</label>
                <label><input type="radio" checked={mode === 'sync'} onChange={() => setMode('sync')} disabled={!canSwitchMode} />{' '}Sync</label>
                <label title="Snap scrub / slide / loop points to beat grid (X to toggle)">
                  <input type="checkbox" checked={snap} onChange={() => setSnap((s) => !s)} />{' '}Snap
                </label>
              </div>

              {/* Transport */}
              <div style={{ marginBottom: 8, display: 'flex', gap: 6 }}>
                <button
                  style={{ ...btnStyle,
                    ...(transport === 'recording' ? { background: '#b91c1c', color: '#fff' }
                      : (transport === 'armed' || transport === 'counting-in') ? { background: '#7f1d1d', color: '#fca5a5' } : {}) }}
                  onClick={() => void handleRecord()}
                  disabled={!ready}>
                  {transport === 'recording' ? '⏺ Rec ●'
                    : transport === 'counting-in' ? '⏺ Count-in…'
                    : (transport === 'armed' || mode === 'sync') ? '⏺ Arm'
                    : '⏺ Record'}
                </button>
                <button style={{ ...btnStyle, ...(transport !== 'idle' ? { background: '#374151', color: '#f9fafb' } : {}) }} onClick={handleStop} disabled={!ready}>
                  {transport === 'playing' ? '⏸ Pause' : '⏹ Stop'}
                </button>
                <button
                  style={{ ...btnStyle, ...(transport === 'playing' ? { background: '#15803d', color: '#fff' } : {}) }}
                  onClick={(e) => handlePlay(e.shiftKey)}
                  disabled={!ready || !hasClips || (transport !== 'idle' && transport !== 'playing' && !(transport === 'armed' && mode === 'free'))}>
                  {transport === 'playing' ? '⏸ Pause' : transport === 'armed' && mode === 'free' ? '▶ Play / ⇧ Count-in' : '▶ Play'}
                </button>
              </div>

              {/* Timeline canvas */}
              <canvas
                ref={canvasRef}
                width={CANVAS_WIDTH}
                height={CANVAS_HEIGHT}
                style={{ display: 'block', cursor: 'crosshair' }}
                onMouseDown={handleCanvasMouseDown}
                onMouseMove={handleCanvasMouseMove}
                onMouseUp={handleCanvasMouseUp}
                onMouseLeave={handleCanvasMouseUp}
              />
              <div style={{ fontSize: 11, color: '#52525b', marginTop: 2 }}>
                Click lane to select · click empty to seek · drag clip to move
              </div>

              {/* Edit buttons */}
              <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button style={btnStyle} onClick={(e) => e.shiftKey ? handleJoin() : handleSplit()} disabled={!canEdit || !selectedClipId}>Split</button>
                <button style={btnStyle} onClick={handleLift} disabled={!canEdit || !selectedClipId}>Lift</button>
                <button style={{ ...btnStyle, ...(clipboard ? { background: '#1d4ed8' } : {}) }} onClick={handleDrop} disabled={!canEdit || !clipboard}>
                  Drop{clipboard ? ' ✓' : ''}
                </button>
                <span style={{ borderLeft: '1px solid #3f3f46', margin: '0 4px' }} />
                <button style={btnStyle} onClick={handleUndo} disabled={undoStack.length === 0}>↩ Undo ({undoStack.length})</button>
                <button style={btnStyle} onClick={handleRedo} disabled={redoStack.length === 0}>↪ Redo ({redoStack.length})</button>
              </div>

              {/* Loop controls */}
              <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                <button style={btnStyle} onClick={handleSetLoopIn} disabled={!canEdit}>Set In</button>
                <button style={btnStyle} onClick={handleSetLoopOut} disabled={!canEdit}>Set Out</button>
                <button style={{ ...btnStyle, ...(tape.loopEnabled ? { background: '#15803d' } : {}) }} onClick={handleToggleLoop}>
                  {tape.loopEnabled ? '⟳ On' : '⟳ Off'}
                </button>
                <button style={btnStyle} onClick={handleLoopFromClip} disabled={!canEdit || !selectedClipId}>Loop from Clip</button>
                {tape.loopOut > tape.loopIn && (
                  <span style={{ fontSize: 12, color: '#a1a1aa' }}>
                    [{(tape.loopIn / sr).toFixed(2)}s — {(tape.loopOut / sr).toFixed(2)}s]
                  </span>
                )}
              </div>

              {/* Clip info */}
              {hasClips && (
                <div style={{ marginTop: 8, fontSize: 12, color: '#71717a' }}>
                  {tape.lanes[tape.activeLane].clips.length} clip{tape.lanes[tape.activeLane].clips.length !== 1 ? 's' : ''} on lane {tape.activeLane + 1}
                  {' · '}tape {(tape.tapeLength / sr).toFixed(2)}s
                  {selectedClipId && (() => {
                    const c = tape.lanes[tape.activeLane].clips.find((x) => x.id === selectedClipId);
                    return c ? ` · ${(c.tapeStart / sr).toFixed(2)}s–${((c.tapeStart + c.duration) / sr).toFixed(2)}s` : null;
                  })()}
                  {lastClipBeats !== null && ` · ${lastClipBeats.toFixed(3)} beats`}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ================================================================ */}
      {/* MIXER tab — per-lane gain, pan, mute                              */}
      {/* ================================================================ */}
      {activeTab === 'MIXER' && (
        <div style={{ display: 'flex', gap: 16 }}>
          {([0, 1, 2, 3] as const).map((li) => {
            const lane = tape.lanes[li];
            const panPct = Math.round(lane.pan * 100);
            const panLabel = panPct === 0 ? 'C' : panPct < 0 ? `L${Math.abs(panPct)}` : `R${panPct}`;
            const gainPct = Math.round(lane.gain * 100);
            return (
              <div key={li} style={{
                background: '#18181b', borderRadius: 6, padding: '12px 14px',
                display: 'flex', flexDirection: 'column', alignItems: 'center',
                gap: 10, minWidth: 90,
                opacity: lane.muted ? 0.5 : 1,
              }}>
                <div style={{ color: tape.activeLane === li ? '#818cf8' : '#a1a1aa', fontSize: 13, fontWeight: tape.activeLane === li ? 600 : 400 }}>
                  Lane {li + 1}
                </div>

                {/* Gain fader */}
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, width: '100%' }}>
                  <span style={{ fontSize: 11, color: '#52525b' }}>Vol</span>
                  <div style={{ position: 'relative', height: 80, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <input
                      type="range" min={0} max={2} step={0.01} value={lane.gain}
                      onChange={(e) => handleLaneGain(li, Number(e.target.value))}
                      style={{ width: 76, transform: 'rotate(-90deg)', transformOrigin: 'center center', position: 'absolute' }}
                    />
                  </div>
                  <span style={{ fontSize: 11, color: '#71717a' }}>{gainPct}%</span>
                </div>

                {/* Pan knob */}
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, width: '100%' }}>
                  <span style={{ fontSize: 11, color: '#52525b' }}>Pan</span>
                  <input
                    type="range" min={-1} max={1} step={0.01} value={lane.pan}
                    onChange={(e) => handleLanePan(li, Number(e.target.value))}
                    style={{ width: '100%' }}
                  />
                  <span style={{ fontSize: 11, color: '#71717a' }}>{panLabel}</span>
                </div>

                {/* Mute */}
                <button
                  onClick={() => handleLaneMute(li)}
                  style={{ ...btnStyle, fontSize: 11, width: '100%',
                    ...(lane.muted ? { background: '#92400e', color: '#fcd34d', borderColor: '#b45309' } : {}),
                  }}>
                  {lane.muted ? 'Muted' : 'Mute'}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* ================================================================ */}
      {/* PROJ tab — session save / load                                    */}
      {/* ================================================================ */}
      {activeTab === 'PROJ' && (
        <>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
            <input
              type="text"
              placeholder="Session name"
              value={sessionName}
              onChange={(e) => setSessionName(e.target.value)}
              style={{ padding: '3px 8px', background: '#27272a', border: '1px solid #3f3f46', color: '#e4e4e7', borderRadius: 4, width: 180 }}
            />
            <button style={btnStyle} onClick={handleSave} disabled={!sessionName.trim()}>Save</button>
            <button style={btnStyle} onClick={handleNew}>New</button>
            {sessions.length > 0 && (
              <select
                style={{ padding: '3px 8px', background: '#27272a', border: '1px solid #3f3f46', color: '#e4e4e7', borderRadius: 4 }}
                defaultValue=""
                onChange={(e) => { if (e.target.value) void handleLoad(e.target.value); }}
              >
                <option value="" disabled>Load session…</option>
                {sessions.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            )}
            {sessionName && sessions.includes(sessionName) && (
              <button style={{ ...btnStyle, color: '#f87171' }} onClick={() => void handleDeleteSession(sessionName)}>Delete</button>
            )}
          </div>
          {sessionStatus && <div style={{ fontSize: 12, color: '#a1a1aa' }}>{sessionStatus}</div>}
        </>
      )}

      {/* ================================================================ */}
      {/* TEST tab — latency tests & diagnostics                            */}
      {/* ================================================================ */}
      {activeTab === 'TEST' && (
        <>
          {!ready && (
            <button onClick={() => void handleInit()} style={btnStyle}>Enable Audio + MIDI</button>
          )}
          {ready && (
            <>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
                <button style={btnStyle} onClick={handleLatencyTest} disabled={!canEdit}>Run Loopback Latency Test</button>
                <button style={btnStyle} onClick={handleOpZLatencyTest} disabled={!canEdit || !selectedMidiOutputId}>Run OP-Z Latency Test</button>
                <button style={btnStyle} onClick={() => { syncEngineRef.current?.sendNoteOn(OPZ_TEST_NOTE, 100, OPZ_PERCUSSION_CHANNEL); setTimeout(() => syncEngineRef.current?.sendNoteOff(OPZ_TEST_NOTE, OPZ_PERCUSSION_CHANNEL), 150); }} disabled={!selectedMidiOutputId}>Send Test Note</button>
                <button style={btnStyle} onClick={() => syncEngineRef.current?.sendStart()} disabled={!selectedMidiOutputId}>Send MIDI Start</button>
                <button style={btnStyle} onClick={() => syncEngineRef.current?.sendStop()} disabled={!selectedMidiOutputId}>Send MIDI Stop</button>
              </div>
              {(latency || noteLatency) && (
                <div style={{ fontSize: 13, marginBottom: 8 }}>
                  {latency && (
                    <div>
                      Loopback latency: {latency.latencyMs.toFixed(1)} ms (confidence {latency.confidence.toFixed(2)})
                      {latency.confidence < 0.6 && <span style={{ color: '#f59e0b' }}> — low confidence</span>}
                    </div>
                  )}
                  {noteLatency && (
                    <div>OP-Z note→sound: {noteLatency.latencyMs !== null ? `${noteLatency.latencyMs.toFixed(1)} ms` : 'not detected'}</div>
                  )}
                </div>
              )}
              <div style={{ fontSize: 12, color: '#71717a', marginBottom: 8 }}>
                Zoom: {(samplesPerPixelRef.current / 44100).toFixed(3)} s/px
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <span style={{ fontSize: 13, color: '#a1a1aa' }}>Activity log ({activityLogRef.current.length})</span>
                <button style={{ ...btnStyle, fontSize: 11 }} onClick={() => { activityLogRef.current = []; forceLogUpdate((v) => v + 1); }}>Clear</button>
              </div>
              <div style={{ fontFamily: 'monospace', fontSize: 12, color: '#a1a1aa', background: '#18181b', borderRadius: 4, padding: '8px 12px', maxHeight: 360, overflowY: 'auto' }}>
                {activityLogRef.current.length === 0
                  ? <span style={{ color: '#52525b' }}>No events yet.</span>
                  : activityLogRef.current.slice().reverse().map((entry, i) => (
                      <div key={i} style={{ whiteSpace: 'pre', lineHeight: '1.6' }}>{entry}</div>
                    ))
                }
              </div>
            </>
          )}
        </>
      )}

    </div>
  );
}

const btnStyle: React.CSSProperties = {
  padding: '4px 10px',
  background: '#27272a',
  border: '1px solid #3f3f46',
  color: '#e4e4e7',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: 13,
};


