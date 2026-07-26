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
import {
  deleteClip,
  dropClip,
  joinClips,
  liftClip,
  moveClip,
  splitClip,
  tapeLengthFromLanes,
  toggleMute,
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

// Canvas dimensions — 200px fits 4 lanes (each ~45px) + 20px time axis.
const CANVAS_WIDTH = 900;
const CANVAS_HEIGHT = 200;

// Default zoom: samples per pixel. 20 s visible at 44100 Hz across 900 px.
const DEFAULT_SAMPLES_PER_PIXEL = Math.round((20 * 44100) / CANVAS_WIDTH);

type Mode = 'free' | 'sync';
type TransportState = 'idle' | 'armed' | 'recording' | 'playing';

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
  const [midiInputs, setMidiInputs] = useState<{ id: string; name: string | null }[]>([]);
  const [selectedMidiInputId, setSelectedMidiInputId] = useState<string | 'all'>('all');
  const [midiOutputs, setMidiOutputs] = useState<{ id: string; name: string | null }[]>([]);
  const [selectedMidiOutputId, setSelectedMidiOutputId] = useState<string | null>(null);

  // Tape & transport state
  const [tape, setTape] = useState<Tape>(makeDefaultTape());
  const [transport, setTransport] = useState<TransportState>('idle');
  const [mode, setMode] = useState<Mode>('sync');

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

  // Refs for real-time values (avoid stale closures in rAF loop)
  const tapeRef = useRef<Tape>(tape);
  tapeRef.current = tape;
  const transportRef = useRef<TransportState>(transport);
  transportRef.current = transport;
  const poolDisplayRef = useRef<AudioPool>(poolRef.current);

  // Tracks tape position at start of recording
  const tapeStartForRecordingRef = useRef(0);
  const recordStartWallTimeRef = useRef(0); // Date.now() when recording began
  const armedForSyncRef = useRef(false);

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
          if (armedForSyncRef.current) {
            armedForSyncRef.current = false;
            const armTape = tapeRef.current;
            tapeStartForRecordingRef.current = armTape.playhead;
            recordStartWallTimeRef.current = Date.now();
            // Load all existing clips so other lanes play back while recording.
            engine.loadTape(armTape.lanes.flatMap((l) => l.clips), poolRef.current);
            engine.play(armTape.playhead, { loopIn: armTape.loopIn, loopOut: armTape.loopOut, loopEnabled: armTape.loopEnabled });
            engine.startRecording();
            setTransport('recording');
          }
        } else if (event.type === 'stop') {
          setSyncRunning(false);
        } else if (event.type === 'clock') {
          setSyncBpm(event.bpm);
          setSyncBeatPosition(event.beatPosition);
          const roundedBpm = Math.round(event.bpm);
          if (roundedBpm !== tapeRef.current.bpm) {
            setTape((prev) => {
              const t = { ...prev, bpm: roundedBpm };
              tapeRef.current = t;
              return t;
            });
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
          // IMPORTANT: only reset transport here if wasPlayingWorklet was true —
          // i.e., the worklet had previously confirmed playing=true. This prevents
          // stale playing=false idle-loop messages (sent before the worklet processes
          // a 'play' command) from knocking transport back to 'idle' immediately after
          // handlePlay sets it to 'playing'.
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
        drawTimeline(ctx, displayTape, poolDisplayRef.current, layout, currentSelectedId);
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
        i === currentTape.activeLane ? { clips: newClips } : l
      ) as [Lane, Lane, Lane, Lane];
      const newTape: Tape = {
        ...currentTape,
        ...(extra ?? {}),
        lanes: newLanes,
        tapeLength: tapeLengthFromLanes(newLanes),
      };
      setTape(newTape);
      tapeRef.current = newTape;
      engineRef.current?.loadTape(newLanes.flatMap((l) => l.clips), poolRef.current);
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
      engineRef.current?.loadTape(entry.lanes.flatMap((l) => l.clips), poolRef.current);
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
      engineRef.current?.loadTape(entry.lanes.flatMap((l) => l.clips), poolRef.current);
      return prev.slice(0, -1);
    });
  }, []);

  // ---------------------------------------------------------------------------
  // Transport
  // ---------------------------------------------------------------------------
  const handleRecord = useCallback(() => {
    const engine = engineRef.current;
    if (!engine) return;
    addLog(`⏺ Record clicked  mode=${mode}  transportRef=${transportRef.current}`);
    if (mode === 'free') {
      // Recording always starts at the current playhead (may be before loopIn).
      const currentTape = tapeRef.current;
      tapeStartForRecordingRef.current = currentTape.playhead;
      recordStartWallTimeRef.current = Date.now();
      // Load all existing clips so other lanes play back while recording.
      engine.loadTape(currentTape.lanes.flatMap((l) => l.clips), poolRef.current);
      engine.play(currentTape.playhead, { loopIn: currentTape.loopIn, loopOut: currentTape.loopOut, loopEnabled: currentTape.loopEnabled });
      engine.startRecording();
      setTransport('recording');
    } else {
      armedForSyncRef.current = true;
      setTransport('armed');
    }
  }, [mode, addLog]);

  const handleStop = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine) return;
    const currentTransport = transportRef.current;
    addLog(`⏹ Stop clicked  transportRef=${currentTransport}`);

    if (currentTransport === 'playing') {
      addLog('→ engine.stopPlayback()');
      engine.stopPlayback();
      setTransport('idle');
      return;
    }
    if (currentTransport === 'armed') {
      addLog('→ arm cancelled');
      armedForSyncRef.current = false;
      setTransport('idle');
      return;
    }
    if (currentTransport === 'recording') {
      engine.stopPlayback();
      const recording = await engine.stopRecording();
      const tapeStart = tapeStartForRecordingRef.current;
      const sr = engine.sampleRate;
      let newClip: Clip;
      if (mode === 'free') {
        const currentTape = tapeRef.current;
        const loopLen = currentTape.loopOut - currentTape.loopIn;
        const isLoopRec = currentTape.loopEnabled && loopLen > 0;
        if (isLoopRec) {
          newClip = finalizeLoopRecording(poolRef.current, recording.samples, tapeStart, currentTape.loopIn, currentTape.loopOut);
          const passes = (recording.samples.length - Math.max(0, currentTape.loopIn - tapeStart)) / loopLen;
          addLog(`✓ Take (loop-overdub): ${(recording.samples.length / sr).toFixed(3)}s raw, ${passes.toFixed(2)}x passes, clip=${((currentTape.loopOut - Math.min(tapeStart, currentTape.loopIn)) / sr).toFixed(3)}s  [${(newClip.tapeStart / sr).toFixed(2)}s–${((newClip.tapeStart + newClip.duration) / sr).toFixed(2)}s]`);
        } else {
          newClip = finalizeFreeRecording(poolRef.current, recording.samples, tapeStart);
          addLog(`✓ Take (free): ${(recording.samples.length / sr).toFixed(3)}s  (${recording.samples.length} samples)  [${(newClip.tapeStart / sr).toFixed(2)}s–${((newClip.tapeStart + newClip.duration) / sr).toFixed(2)}s]`);
        }
        setLastClipBeats(null);
      } else {
        const currentTape = tapeRef.current;
        const loopLen = currentTape.loopOut - currentTape.loopIn;
        const isLoopRec = currentTape.loopEnabled && loopLen > 0;
        if (isLoopRec) {
          // Loop fold takes priority over beat-correction: the clip length is the
          // loop length, so sync stretch is irrelevant.
          newClip = finalizeLoopRecording(poolRef.current, recording.samples, tapeStart, currentTape.loopIn, currentTape.loopOut);
          const passes = (recording.samples.length - Math.max(0, currentTape.loopIn - tapeStart)) / loopLen;
          addLog(`✓ Take (sync+loop): ${(recording.samples.length / sr).toFixed(3)}s raw, ${passes.toFixed(2)}x passes, clip=${((currentTape.loopOut - Math.min(tapeStart, currentTape.loopIn)) / sr).toFixed(3)}s  [${(newClip.tapeStart / sr).toFixed(2)}s–${((newClip.tapeStart + newClip.duration) / sr).toFixed(2)}s]`);
          setLastClipBeats(null);
        } else {
          const syncEngine = syncEngineRef.current;
          const samplesPerBeat = syncEngine?.samplesPerBeat() ?? sr;
          // Derive beat count from audio length rather than syncEngine.beatPosition,
          // which resets to 0 on every MIDI Start.  If the OP-Z loops (sending
          // Stop+Start) mid-take, beatPosition would be far too small and produce
          // a large negative correction.  Rounding raw_samples/samplesPerBeat to
          // the nearest integer always gives a correction of < half a beat.
          const beatsElapsed = Math.round(recording.samples.length / samplesPerBeat);
          newClip = finalizeSyncRecording(poolRef.current, recording.samples, tapeStart, beatsElapsed, samplesPerBeat);
          const rawSamples = recording.samples.length;
          const targetSamples = Math.max(0, Math.round(beatsElapsed * samplesPerBeat));
          const corrSamples = targetSamples - rawSamples;
          addLog(`✓ Take (sync): raw=${(rawSamples / sr).toFixed(3)}s  target=${(targetSamples / sr).toFixed(3)}s  correction=${(corrSamples / sr * 1000).toFixed(1)}ms (${rawSamples > 0 ? (corrSamples / rawSamples * 100).toFixed(1) : '—'}%)  beats=${beatsElapsed.toFixed(3)}  [${(newClip.tapeStart / sr).toFixed(2)}s–${((newClip.tapeStart + newClip.duration) / sr).toFixed(2)}s]`);
          setLastClipBeats(beatsElapsed);
        }
      }
      poolDisplayRef.current = poolRef.current;
      const newClips = [...tapeRef.current.lanes[tapeRef.current.activeLane].clips, newClip];
      applyEdit(tapeRef.current, newClips);
      setTransport('idle');
    }
  }, [mode, applyEdit, addLog]);

  const handlePlay = useCallback(() => {
    const engine = engineRef.current;
    if (!engine) return;
    const currentTape = tapeRef.current;
    addLog(`▶ Play clicked  transportRef=${transportRef.current}  clips=${currentTape.lanes[currentTape.activeLane].clips.length}  playhead=${(currentTape.playhead / engine.sampleRate).toFixed(3)}s`);
    engine.loadTape(currentTape.lanes.flatMap((l) => l.clips), poolRef.current);
    engine.play(currentTape.playhead, {
      loopIn: currentTape.loopIn,
      loopOut: currentTape.loopOut,
      loopEnabled: currentTape.loopEnabled,
    });
    setTransport('playing');
    addLog(`→ engine.play() called  transportRef now set to playing (pending render)`);
  }, [addLog]);

  const handleRewind = useCallback(() => {
    setTape((prev) => {
      const t = { ...prev, playhead: 0 };
      tapeRef.current = t;
      return t;
    });
  }, []);

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
      // Seek: playhead update auto-updates selection.
      const seekPos = Math.max(0, Math.round(tapePos));
      setTape((prev) => {
        const t = { ...prev, playhead: seekPos };
        tapeRef.current = t;
        return t;
      });
    }
  }, [getLayout]);

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
      engineRef.current?.loadTape(currentTape.lanes.flatMap((l) => l.clips), poolRef.current);
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

  const handleDelete = useCallback(() => {
    const currentTape = tapeRef.current;
    const sid = selectedClipIdRef.current;
    if (!sid) return;
    applyEdit(currentTape, deleteClip(currentTape.lanes[currentTape.activeLane].clips, sid));
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

  const handleToggleMute = useCallback(() => {
    const currentTape = tapeRef.current;
    const sid = selectedClipIdRef.current;
    if (!sid) return;
    applyEdit(currentTape, toggleMute(currentTape.lanes[currentTape.activeLane].clips, sid));
  }, [applyEdit]);

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
      await saveSession(sessionName.trim(), tapeRef.current, poolRef.current);
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
      engineRef.current?.loadTape(result.tape.lanes.flatMap((l) => l.clips), result.pool);
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
      case 'play':       handlePlay(); break;
      case 'stop':       handleStop(); break;
      case 'lift':       handleLift(); break;
      case 'drop':       handleDrop(); break;
      case 'split':      event.shift ? handleJoin() : handleSplit(); break;
      case 'loopIn':     handleSetLoopIn(); break;
      case 'loopOut':    handleSetLoopOut(); break;
      case 'loopToggle': event.shift ? handleLoopFromClip() : handleToggleLoop(); break;
      case 'encoderDelta': {
        // Don't move the playhead or loop points while recording/armed.
        if (transportRef.current === 'recording' || transportRef.current === 'armed') break;
        const { index, delta, shift } = event;
        const currentTape = tapeRef.current;
        const sr2 = engineRef.current?.sampleRate ?? 44100;
        // samplesPerBeat derived from the project BPM (updated from MIDI clock).
        const spb = (sr2 * 60) / currentTape.bpm;

        if (index === 1 && !shift) {
          // Blue encoder, no shift: scrub playhead.
          // Sync mode: snap current position to nearest beat first, then step by delta beats.
          // Free mode: 1 delta tick = 1 pixel of current zoom.
          const newPlayhead = mode === 'sync'
            ? Math.max(0, Math.round((Math.round(currentTape.playhead / spb) + delta) * spb))
            : Math.max(0, Math.round(currentTape.playhead + delta * samplesPerPixelRef.current));
          setTape((prev) => { const t = { ...prev, playhead: newPlayhead }; tapeRef.current = t; return t; });
        } else if (index === 0) {
          // Green encoder: adjust loop out (no shift) or loop in (shift).
          // In sync mode, snap the current value to nearest beat first so delta steps land on grid.
          const cur = shift ? currentTape.loopIn : currentTape.loopOut;
          const newVal = mode === 'sync'
            ? Math.max(0, Math.round((Math.round(cur / spb) + delta) * spb))
            : Math.max(0, Math.round((cur / spb + delta) * spb));
          const patch = shift ? { loopIn: newVal } : { loopOut: newVal };
          setTape((prev) => { const t = { ...prev, ...patch }; tapeRef.current = t; return t; });
          const newLoopIn  = shift ? newVal : currentTape.loopIn;
          const newLoopOut = shift ? currentTape.loopOut : newVal;
          syncLoopToEngine(newLoopIn, newLoopOut, currentTape.loopEnabled);
          if (mode === 'sync') {
            const label = shift ? 'in' : 'out';
            addLog(`loop ${label} → ${(newVal / spb).toFixed(2)} beats  (${(newVal / sr2).toFixed(2)}s)`);
          }
        }
        break;
      }
      // shiftChange: modifier state only, no direct action
    }
  };

  // window.__tapeTest hook (for Playwright automation)
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
          engineRef.current?.loadTape(newLanes.flatMap((l) => l.clips), poolRef.current);
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
          engineRef.current?.loadTape(newLanes.flatMap((l) => l.clips), poolRef.current);
          return t;
        });
      },
      saveSession: (name: string) => saveSession(name, tapeRef.current, poolRef.current).then(refreshSessions),
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
    <div style={{ fontFamily: 'sans-serif', color: '#e4e4e7', background: '#09090b', minHeight: '100vh', padding: 24 }}>

      {/* ---- Global header ---- */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 14 }}>
        <h1 style={{ margin: 0, fontSize: 20 }}>Tape</h1>
        <div style={{ display: 'flex', gap: 2 }}>
          {(['COM', 'TAPE', 'MIXER', 'PROJ', 'TEST'] as const).map((tab) => (
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

      {/* ================================================================ */}
      {/* TAPE tab — transport, timeline, edit                              */}
      {/* ================================================================ */}
      {activeTab === 'TAPE' && (
        <>
          {!ready && (
            <button onClick={() => void handleInit()} style={btnStyle}>Enable Audio + MIDI</button>
          )}
          {ready && (
            <>
              {/* Lane selector + status bar */}
              <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginBottom: 6 }}>
                {([0, 1, 2, 3] as const).map((i) => (
                  <button key={i} onClick={() => setTape((prev) => { const t = { ...prev, activeLane: i }; tapeRef.current = t; return t; })}
                    style={{ ...btnStyle, background: tape.activeLane === i ? '#4338ca' : '#27272a', borderColor: tape.activeLane === i ? '#6366f1' : '#3f3f46', minWidth: 28, fontWeight: tape.activeLane === i ? 600 : 400 }}>
                    {i + 1}
                  </button>
                ))}
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

              {/* Mode */}
              <div style={{ marginBottom: 6 }}>
                <label><input type="radio" checked={mode === 'free'} onChange={() => setMode('free')} disabled={!canEdit} />{' '}Free</label>
                <label style={{ marginLeft: 12 }}><input type="radio" checked={mode === 'sync'} onChange={() => setMode('sync')} disabled={!canEdit} />{' '}Sync</label>
              </div>

              {/* Transport */}
              <div style={{ marginBottom: 8, display: 'flex', gap: 6 }}>
                <button style={btnStyle} onClick={handleRecord} disabled={!canEdit}>{mode === 'sync' ? '⏺ Arm' : '⏺ Record'}</button>
                <button style={btnStyle} onClick={handleStop} disabled={transport === 'idle'}>⏹ Stop</button>
                <button style={btnStyle} onClick={handlePlay} disabled={transport !== 'idle' || !hasClips}>▶ Play</button>
                <button style={btnStyle} onClick={handleRewind} disabled={!canEdit}>⏮ Rewind</button>
              </div>

              {/* Timeline canvas */}
              <canvas
                ref={canvasRef}
                width={CANVAS_WIDTH}
                height={CANVAS_HEIGHT}
                style={{ border: '1px solid #3f3f46', display: 'block', cursor: 'crosshair' }}
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
                <button style={btnStyle} onClick={handleSplit} disabled={!canEdit || !selectedClipId}>Split</button>
                <button style={btnStyle} onClick={handleDelete} disabled={!canEdit || !selectedClipId}>Delete</button>
                <button style={btnStyle} onClick={handleLift} disabled={!canEdit || !selectedClipId}>Lift</button>
                <button style={{ ...btnStyle, ...(clipboard ? { background: '#1d4ed8' } : {}) }} onClick={handleDrop} disabled={!canEdit || !clipboard}>
                  Drop{clipboard ? ' ✓' : ''}
                </button>
                <button style={btnStyle} onClick={handleJoin} disabled={!canEdit || !selectedClipId}>Join</button>
                <button style={btnStyle} onClick={handleToggleMute} disabled={!canEdit || !selectedClipId}>
                  {selectedClipId && tape.lanes[tape.activeLane].clips.find((c) => c.id === selectedClipId)?.muted ? 'Unmute' : 'Mute'}
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
        </>
      )}

      {/* ================================================================ */}
      {/* MIXER tab — per-lane controls                                     */}
      {/* ================================================================ */}
      {activeTab === 'MIXER' && (
        <>
          <div style={{ color: '#71717a', fontSize: 13, marginBottom: 12 }}>Mixer</div>
          <div style={{ display: 'flex', gap: 12 }}>
            {([0, 1, 2, 3] as const).map((li) => (
              <div key={li} style={{ background: '#18181b', borderRadius: 6, padding: '10px 16px', textAlign: 'center', minWidth: 80 }}>
                <div style={{ color: '#818cf8', marginBottom: 8, fontSize: 13 }}>Lane {li + 1}</div>
                <button style={{ ...btnStyle, fontSize: 11 }}>Mute</button>
              </div>
            ))}
          </div>
        </>
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
              <div style={{ fontSize: 12, color: '#71717a' }}>
                Zoom: {(samplesPerPixelRef.current / 44100).toFixed(3)} s/px
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


