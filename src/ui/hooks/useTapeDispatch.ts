// useTapeDispatch — single dispatcher absorbing all tape state mutations.
// Replaces useEditOps + useTransport; TapePage imports only this hook.
import { useCallback, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { AudioEngine } from '../../audio/audioEngine';
import { AudioPool } from '../../audio/audioPool';
import { type Clip, type Lane, type Tape, makeDefaultTape } from '../../tape/model';
import {
  applyOverwrite,
  dropClip,
  joinClips,
  liftClip,
  moveClip,
  splitClip,
  tapeLengthFromLanes,
} from '../../tape/editEngine';
import { deleteSession, listSessions, loadSession, saveSession } from '../../tape/session';
import { finalizeFreeRecording, finalizeLoopRecording, finalizeSyncRecording } from '../../tape/recording';
import { createClickWaveform } from '../../audio/clickWaveform';
import { type TapeEngineRefs, type TransportState, type UndoEntry, type Mode, snapshotTape } from '../tapeRefs';
import type { TapeAction } from '../tapeActions';

interface DispatchDeps {
  setTape:          Dispatch<SetStateAction<Tape>>;
  setTransport:     Dispatch<SetStateAction<TransportState>>;
  setUndoStack:     Dispatch<SetStateAction<UndoEntry[]>>;
  setRedoStack:     Dispatch<SetStateAction<UndoEntry[]>>;
  setClipboard:     Dispatch<SetStateAction<Clip | null>>;
  setSessions:      Dispatch<SetStateAction<string[]>>;
  setSessionStatus: Dispatch<SetStateAction<string>>;
  setSessionName:   Dispatch<SetStateAction<string>>;
  setMode:          Dispatch<SetStateAction<Mode>>;
  setSnap:          Dispatch<SetStateAction<boolean>>;
  setLastClipBeats: Dispatch<SetStateAction<number | null>>;
  clipboard:        Clip | null;
  sessionName:      string;
}

export function useTapeDispatch(refs: TapeEngineRefs, deps: DispatchDeps) {
  const {
    engineRef, syncEngineRef, poolRef, poolDisplayRef,
    tapeRef, transportRef, modeRef, snapRef, outputLatencyMsRef,
    tapeStartForRecordingRef, recordStartWallTimeRef,
    loopRotateTimeoutRef, loopRotatingRef, armedRef,
    cancelCountInRef, addLogFnRef, selectedClipIdRef, samplesPerPixelRef,
  } = refs;

  const {
    setTape, setTransport, setUndoStack, setRedoStack, setClipboard,
    setSessions, setSessionStatus, setSessionName, setMode, setSnap,
    setLastClipBeats,
  } = deps;

  // Mirror reactive values into refs so dispatch always sees the latest.
  const clipboardRef = useRef<Clip | null>(deps.clipboard);
  clipboardRef.current = deps.clipboard;
  const sessionNameRef = useRef(deps.sessionName);
  sessionNameRef.current = deps.sessionName;

  // ---------------------------------------------------------------------------
  // Private helpers (stable useCallbacks — all mutable state accessed via refs)
  // ---------------------------------------------------------------------------

  const pushUndo = useCallback((currentTape: Tape) => {
    setUndoStack((prev) => [...prev, snapshotTape(currentTape)]);
    setRedoStack([]);
  }, [setUndoStack, setRedoStack]);

  const applyEdit = useCallback((currentTape: Tape, newClips: Clip[], extra?: Partial<Tape>): Tape => {
    pushUndo(currentTape);
    const newLanes = currentTape.lanes.map((l, i) =>
      i === currentTape.activeLane ? { ...l, clips: newClips } : l
    ) as [Lane, Lane, Lane, Lane];
    const newTape: Tape = { ...currentTape, ...(extra ?? {}), lanes: newLanes, tapeLength: tapeLengthFromLanes(newLanes) };
    setTape(newTape);
    tapeRef.current = newTape;
    engineRef.current?.loadTape(newLanes, poolRef.current);
    return newTape;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pushUndo, setTape]);

  const syncLoopToEngine = useCallback((loopIn: number, loopOut: number, loopEnabled: boolean) => {
    if (transportRef.current === 'playing') engineRef.current?.setLoop({ loopIn, loopOut, loopEnabled });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshSessions = useCallback(async () => {
    const names = await listSessions();
    setSessions(names);
  }, [setSessions]);

  const startLoopRotation = useCallback((firstPassStart: number, firstWallTime: number) => {
    loopRotatingRef.current = true;
    const doRotation = async (passStart: number, wallTime: number) => {
      loopRotateTimeoutRef.current = setTimeout(async () => {
        if (transportRef.current !== 'recording' || modeRef.current !== 'free') return;
        const eng = engineRef.current;
        if (!eng) return;
        const { loopIn, loopOut } = tapeRef.current;
        const sr = eng.sampleRate;
        const latSamples = Math.round(outputLatencyMsRef.current * sr / 1000);
        const adjStart = Math.max(0, passStart - latSamples);
        const rec = await eng.rotateRecording();
        if (rec.samples.length > 0) {
          const existing = tapeRef.current.lanes[tapeRef.current.activeLane].clips;
          const clip = finalizeFreeRecording(poolRef.current, rec.samples, adjStart, existing);
          poolDisplayRef.current = poolRef.current;
          applyEdit(tapeRef.current, applyOverwrite(existing, clip));
          addLogFnRef.current(`↻ Loop pass: ${(rec.samples.length / sr).toFixed(3)}s`);
        }
        tapeStartForRecordingRef.current = loopIn;
        doRotation(loopIn, wallTime + (loopOut - loopIn) / eng.sampleRate * 1000);
      }, Math.max(0, wallTime - Date.now()));
    };
    doRotation(firstPassStart, firstWallTime);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyEdit]);

  const finalizeRecordingTake = useCallback(async (engine: AudioEngine): Promise<void> => {
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

    const existingClips = tapeRef.current.lanes[tapeRef.current.activeLane].clips;

    if (modeRef.current === 'free') {
      const tape = tapeRef.current;
      const loopLen = tape.loopOut - tape.loopIn;
      const latSamples = Math.round(outputLatencyMsRef.current * sr / 1000);
      const adjStart = Math.max(0, tapeStart - latSamples);

      if (wasLoopRotating) {
        if (recording.samples.length === 0) return;
        newClip = finalizeFreeRecording(poolRef.current, recording.samples, adjStart, existingClips);
        addLogFnRef.current(`✓ Take (loop-rotate tail): ${(recording.samples.length / sr).toFixed(3)}s`);
      } else if (tape.loopEnabled && loopLen > 0) {
        newClip = finalizeLoopRecording(poolRef.current, recording.samples, adjStart, tape.loopIn, tape.loopOut, existingClips);
        const passes = (recording.samples.length - Math.max(0, tape.loopIn - adjStart)) / loopLen;
        addLogFnRef.current(`✓ Take (loop-overdub): ${(recording.samples.length / sr).toFixed(3)}s raw, ${passes.toFixed(2)}x passes  latency-adj=${outputLatencyMsRef.current.toFixed(1)}ms`);
      } else {
        newClip = finalizeFreeRecording(poolRef.current, recording.samples, adjStart, existingClips);
        addLogFnRef.current(`✓ Take (free): ${(recording.samples.length / sr).toFixed(3)}s  latency-adj=${outputLatencyMsRef.current.toFixed(1)}ms`);
      }
      setLastClipBeats(null);
    } else {
      const tape = tapeRef.current;
      const loopLen = tape.loopOut - tape.loopIn;
      if (tape.loopEnabled && loopLen > 0) {
        newClip = finalizeLoopRecording(poolRef.current, recording.samples, tapeStart, tape.loopIn, tape.loopOut);
        const passes = (recording.samples.length - Math.max(0, tape.loopIn - tapeStart)) / loopLen;
        addLogFnRef.current(`✓ Take (sync+loop): ${(recording.samples.length / sr).toFixed(3)}s raw, ${passes.toFixed(2)}x passes`);
        setLastClipBeats(null);
      } else {
        const syncEngine = syncEngineRef.current;
        const samplesPerBeat = syncEngine?.samplesPerBeat() ?? sr;
        const beatsElapsed = Math.round(recording.samples.length / samplesPerBeat);
        newClip = finalizeSyncRecording(poolRef.current, recording.samples, tapeStart, beatsElapsed, samplesPerBeat);
        const raw = recording.samples.length;
        const target = Math.max(0, Math.round(beatsElapsed * samplesPerBeat));
        addLogFnRef.current(`✓ Take (sync): raw=${(raw / sr).toFixed(3)}s  correction=${((target - raw) / sr * 1000).toFixed(1)}ms  beats=${beatsElapsed}`);
        setLastClipBeats(beatsElapsed);
      }
    }

    poolDisplayRef.current = poolRef.current;
    applyEdit(tapeRef.current, applyOverwrite(existingClips, newClip));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyEdit, setLastClipBeats]);

  // ---------------------------------------------------------------------------
  // Stable dispatch — implementation ref is updated every render so it always
  // closes over the latest callbacks, while the outer dispatch is constant.
  // (Same pattern as ctrlModeHandlerRef.)
  // ---------------------------------------------------------------------------
  const dispatchImplRef = useRef<(action: TapeAction) => void>(() => {});
  const dispatch = useCallback((action: TapeAction) => dispatchImplRef.current(action), []);

  dispatchImplRef.current = (action: TapeAction): void => {
    switch (action.type) {

      // ── Transport ──────────────────────────────────────────────────────────

      case 'record': {
        const engine = engineRef.current;
        if (!engine) break;
        const tr = transportRef.current;
        addLogFnRef.current(`⏺ Record  transport=${tr}  mode=${modeRef.current}`);
        if (tr === 'recording') {
          void finalizeRecordingTake(engine).then(() => {
            transportRef.current = 'playing';
            setTransport('playing');
          });
          break;
        }
        if (tr === 'counting-in') {
          cancelCountInRef.current?.();
          armedRef.current = false;
          transportRef.current = 'idle';
          setTransport('idle');
          addLogFnRef.current('→ count-in cancelled');
          break;
        }
        if (tr === 'playing') {
          const tape = tapeRef.current;
          tapeStartForRecordingRef.current = tape.playhead;
          recordStartWallTimeRef.current = Date.now();
          engine.startRecording();
          if (modeRef.current === 'free' && tape.loopEnabled && tape.loopOut > tape.loopIn) {
            startLoopRotation(tape.playhead, Date.now() + Math.max(0, (tape.loopOut - tape.playhead) / engine.sampleRate * 1000));
          }
          transportRef.current = 'recording';
          setTransport('recording');
          addLogFnRef.current(`⏺ Recording started at ${(tape.playhead / engine.sampleRate).toFixed(3)}s`);
          break;
        }
        if (tr === 'armed') {
          armedRef.current = false;
          transportRef.current = 'idle';
          setTransport('idle');
          addLogFnRef.current('→ disarmed');
          break;
        }
        // idle → arm
        armedRef.current = true;
        if (modeRef.current === 'free') {
          transportRef.current = 'armed';
          setTransport('armed');
          addLogFnRef.current('⏺ Armed (free) — press Play to record, Shift+Play for count-in');
        } else {
          setTransport('armed');
        }
        break;
      }

      case 'stop': {
        const engine = engineRef.current;
        if (!engine) break;
        const tr = transportRef.current;
        addLogFnRef.current(`⏹ Stop  transport=${tr}`);
        if (tr === 'idle') {
          const rewindPos = tapeRef.current.loopEnabled ? tapeRef.current.loopIn : 0;
          setTape((prev) => { const t = { ...prev, playhead: rewindPos }; tapeRef.current = t; return t; });
          addLogFnRef.current(`⏮ Rewind to ${(rewindPos / engine.sampleRate).toFixed(3)}s`);
          break;
        }
        if (tr === 'playing')     { engine.stopPlayback(); setTransport('idle'); addLogFnRef.current('⏸ Pause'); break; }
        if (tr === 'armed')       { armedRef.current = false; setTransport('idle'); break; }
        if (tr === 'counting-in') {
          cancelCountInRef.current?.();
          armedRef.current = false;
          transportRef.current = 'idle';
          setTransport('idle');
          break;
        }
        if (tr === 'recording') {
          engine.stopPlayback();
          void finalizeRecordingTake(engine).then(() => setTransport('idle'));
        }
        break;
      }

      case 'play': {
        const engine = engineRef.current;
        if (!engine) break;
        const tr = transportRef.current;
        const withCountIn = action.countIn ?? false;

        if (tr === 'recording') {
          void finalizeRecordingTake(engine).then(() => {
            engine.stopPlayback();
            armedRef.current = true;
            transportRef.current = 'armed';
            setTransport('armed');
            addLogFnRef.current('⏺ Take finalized — re-armed');
          });
          break;
        }
        if (tr === 'playing') { engine.stopPlayback(); setTransport('idle'); addLogFnRef.current('⏸ Pause'); break; }
        if (tr === 'armed' && modeRef.current === 'free') {
          const startPlayAndRecord = () => {
            const tape = tapeRef.current;
            armedRef.current = false;
            tapeStartForRecordingRef.current = tape.playhead;
            recordStartWallTimeRef.current = Date.now();
            engine.loadTape(tape.lanes, poolRef.current);
            engine.play(tape.playhead, { loopIn: tape.loopIn, loopOut: tape.loopOut, loopEnabled: tape.loopEnabled });
            engine.startRecording();
            if (tape.loopEnabled && tape.loopOut > tape.loopIn) {
              startLoopRotation(tape.playhead, Date.now() + Math.max(0, (tape.loopOut - tape.playhead) / engine.sampleRate * 1000));
            }
            transportRef.current = 'recording';
            setTransport('recording');
            addLogFnRef.current(`⏺ Recording started at ${(tape.playhead / engine.sampleRate).toFixed(3)}s`);
          };
          if (!withCountIn) { startPlayAndRecord(); break; }
          // Count-in: 4 metronome clicks then record.
          const ctx = engine.audioContext;
          const bpm = tapeRef.current.bpm || 120;
          const beatDur = 60 / bpm;
          const clickWf = createClickWaveform(ctx.sampleRate);
          const clickBuf = ctx.createBuffer(1, clickWf.length, ctx.sampleRate);
          clickBuf.copyToChannel(new Float32Array(clickWf), 0);
          const nodes: AudioBufferSourceNode[] = [];
          for (let beat = 0; beat < 4; beat++) {
            const node = ctx.createBufferSource();
            node.buffer = clickBuf;
            const gainNode = ctx.createGain();
            gainNode.gain.value = beat === 0 ? 1.0 : 0.5;
            node.connect(gainNode);
            gainNode.connect(ctx.destination);
            node.start(ctx.currentTime + beat * beatDur);
            nodes.push(node);
          }
          let cancelled = false;
          cancelCountInRef.current = () => {
            cancelled = true;
            for (const n of nodes) { try { n.stop(); } catch { /* ended */ } }
            cancelCountInRef.current = null;
          };
          const countInMs = 4 * beatDur * 1000;
          addLogFnRef.current(`⏺ Count-in: ${bpm.toFixed(0)} BPM, ${(countInMs / 1000).toFixed(2)}s`);
          transportRef.current = 'counting-in';
          setTransport('counting-in');
          setTimeout(() => { if (!cancelled) { cancelCountInRef.current = null; startPlayAndRecord(); } }, countInMs);
          break;
        }
        if (tr === 'armed') break; // sync-armed: wait for MIDI clock
        // idle → plain playback
        const tape = tapeRef.current;
        addLogFnRef.current(`▶ Play  playhead=${(tape.playhead / engine.sampleRate).toFixed(3)}s`);
        engine.loadTape(tape.lanes, poolRef.current);
        engine.play(tape.playhead, { loopIn: tape.loopIn, loopOut: tape.loopOut, loopEnabled: tape.loopEnabled });
        setTransport('playing');
        break;
      }

      // ── Engine events ──────────────────────────────────────────────────────

      case 'midiClockStart': {
        if (!armedRef.current) break;
        const engine = engineRef.current;
        if (!engine) break;
        armedRef.current = false;
        const tape = tapeRef.current;
        tapeStartForRecordingRef.current = tape.playhead;
        recordStartWallTimeRef.current = Date.now();
        engine.loadTape(tape.lanes, poolRef.current);
        engine.play(tape.playhead, { loopIn: tape.loopIn, loopOut: tape.loopOut, loopEnabled: tape.loopEnabled });
        engine.startRecording();
        transportRef.current = 'recording';
        setTransport('recording');
        break;
      }

      case 'workletPlaybackStopped': {
        if (transportRef.current === 'playing') setTransport('idle');
        break;
      }

      // ── Navigation ─────────────────────────────────────────────────────────

      case 'selectLane': {
        const { lane } = action;
        setTape((prev) => { const t = { ...prev, activeLane: lane }; tapeRef.current = t; return t; });
        addLogFnRef.current(`◈ Lane ${lane + 1} selected`);
        break;
      }

      case 'toggleMuteLane': {
        const { lane } = action;
        setTape((prev) => {
          const newLanes = prev.lanes.map((l, i) => i === lane ? { ...l, muted: !l.muted } : l) as [Lane, Lane, Lane, Lane];
          const t = { ...prev, lanes: newLanes };
          tapeRef.current = t;
          engineRef.current?.loadTape(newLanes, poolRef.current);
          return t;
        });
        addLogFnRef.current(`◈ Lane ${lane + 1} mute toggled`);
        break;
      }

      case 'seekPlayhead': {
        setTape((prev) => { const t = { ...prev, playhead: action.samples }; tapeRef.current = t; return t; });
        break;
      }

      // ── Encoder ────────────────────────────────────────────────────────────

      case 'encoderNudge': {
        const { index, delta, shift } = action;
        const tape = tapeRef.current;
        const sr = engineRef.current?.sampleRate ?? 44100;
        const spb = (sr * 60) / tape.bpm;
        const snap = snapRef.current;
        const spp = samplesPerPixelRef.current;

        if (index === 1 && !shift) {
          if (transportRef.current === 'recording' || transportRef.current === 'armed') break;
          const newPlayhead = snap
            ? Math.max(0, Math.round((Math.round(tape.playhead / spb) + delta) * spb))
            : Math.max(0, Math.round(tape.playhead + delta * spp));
          setTape((prev) => { const t = { ...prev, playhead: newPlayhead }; tapeRef.current = t; return t; });
        } else if (index === 1 && shift) {
          const sid = selectedClipIdRef.current;
          if (!sid) break;
          const clip = tape.lanes[tape.activeLane].clips.find((c) => c.id === sid);
          if (!clip) break;
          const ds = snap ? Math.round(delta * spb) : Math.round(delta * spp);
          const newTapeStart = Math.max(0, clip.tapeStart + ds);
          const newPlayhead = Math.max(0, tape.playhead + (newTapeStart - clip.tapeStart));
          applyEdit(tape, moveClip(tape.lanes[tape.activeLane].clips, sid, newTapeStart), { playhead: newPlayhead });
        } else if (index === 0) {
          const cur = shift ? tape.loopIn : tape.loopOut;
          const newVal = snap
            ? Math.max(0, Math.round((Math.round(cur / spb) + delta) * spb))
            : Math.max(0, Math.round(cur + delta * spp));
          const patch = shift ? { loopIn: newVal } : { loopOut: newVal };
          setTape((prev) => { const t = { ...prev, ...patch }; tapeRef.current = t; return t; });
          syncLoopToEngine(shift ? newVal : tape.loopIn, shift ? tape.loopOut : newVal, tape.loopEnabled);
          if (snap) addLogFnRef.current(`loop ${shift ? 'in' : 'out'} → ${(newVal / spb).toFixed(2)} beats  (${(newVal / sr).toFixed(2)}s)`);
        }
        break;
      }

      // ── Editing ────────────────────────────────────────────────────────────

      case 'split': {
        const tape = tapeRef.current;
        const sid = selectedClipIdRef.current;
        if (!sid) break;
        const newClips = splitClip(tape.lanes[tape.activeLane].clips, sid, tape.playhead);
        if (newClips !== tape.lanes[tape.activeLane].clips) applyEdit(tape, newClips);
        break;
      }

      case 'join': {
        const tape = tapeRef.current;
        const clips = tape.lanes[tape.activeLane].clips;
        const sid = selectedClipIdRef.current;
        if (!sid || clips.length < 2) break;
        const idx = clips.findIndex((c) => c.id === sid);
        if (idx < 0) break;
        const neighbour = clips[idx + 1] ?? clips[idx - 1];
        if (!neighbour) break;
        const { clips: newClips, pool } = joinClips(clips, sid, neighbour.id, poolRef.current);
        poolRef.current = pool;
        poolDisplayRef.current = pool;
        applyEdit(tape, newClips);
        break;
      }

      case 'lift': {
        const tape = tapeRef.current;
        const sid = selectedClipIdRef.current;
        if (!sid) break;
        const { clips: newClips, lifted } = liftClip(tape.lanes[tape.activeLane].clips, sid);
        if (!lifted) break;
        setClipboard(lifted);
        applyEdit(tape, newClips);
        break;
      }

      case 'drop': {
        const cb = clipboardRef.current;
        if (!cb) break;
        const tape = tapeRef.current;
        const newClips = dropClip(tape.lanes[tape.activeLane].clips, cb, tape.playhead);
        const dropped = newClips[newClips.length - 1]!;
        applyEdit(tape, newClips);
        setTape((prev) => { const t = { ...prev, playhead: dropped.tapeStart + dropped.duration }; tapeRef.current = t; return t; });
        break;
      }

      case 'undo': {
        setUndoStack((prev) => {
          if (prev.length === 0) return prev;
          const entry = prev[prev.length - 1]!;
          setRedoStack((r) => [...r, snapshotTape(tapeRef.current)]);
          const newTape: Tape = { ...tapeRef.current, lanes: entry.lanes, tapeLength: tapeLengthFromLanes(entry.lanes), loopIn: entry.loopIn, loopOut: entry.loopOut, loopEnabled: entry.loopEnabled };
          setTape(newTape);
          tapeRef.current = newTape;
          engineRef.current?.loadTape(entry.lanes, poolRef.current);
          return prev.slice(0, -1);
        });
        break;
      }

      case 'redo': {
        setRedoStack((prev) => {
          if (prev.length === 0) return prev;
          const entry = prev[prev.length - 1]!;
          setUndoStack((u) => [...u, snapshotTape(tapeRef.current)]);
          const newTape: Tape = { ...tapeRef.current, lanes: entry.lanes, tapeLength: tapeLengthFromLanes(entry.lanes), loopIn: entry.loopIn, loopOut: entry.loopOut, loopEnabled: entry.loopEnabled };
          setTape(newTape);
          tapeRef.current = newTape;
          engineRef.current?.loadTape(entry.lanes, poolRef.current);
          return prev.slice(0, -1);
        });
        break;
      }

      case 'commitDrag': {
        if (action.from === action.to) break;
        const tape = tapeRef.current;
        setUndoStack((prev) => [...prev, snapshotTape(tape)]);
        setRedoStack([]);
        engineRef.current?.loadTape(tape.lanes, poolRef.current);
        break;
      }

      // ── Loop ───────────────────────────────────────────────────────────────

      case 'setLoopIn': {
        const tape = tapeRef.current;
        pushUndo(tape);
        setTape((prev) => { const t = { ...prev, loopIn: prev.playhead }; tapeRef.current = t; return t; });
        syncLoopToEngine(tape.playhead, tape.loopOut, tape.loopEnabled);
        break;
      }

      case 'setLoopOut': {
        const tape = tapeRef.current;
        pushUndo(tape);
        setTape((prev) => { const t = { ...prev, loopOut: prev.playhead }; tapeRef.current = t; return t; });
        syncLoopToEngine(tape.loopIn, tape.playhead, tape.loopEnabled);
        break;
      }

      case 'toggleLoop': {
        const tape = tapeRef.current;
        const sr = engineRef.current?.sampleRate ?? 44100;
        const newEnabled = !tape.loopEnabled;
        addLogFnRef.current(`⟳ Loop ${newEnabled ? 'on' : 'off'}  in=${(tape.loopIn / sr).toFixed(2)}s  out=${(tape.loopOut / sr).toFixed(2)}s`);
        setTape((prev) => { const t = { ...prev, loopEnabled: newEnabled }; tapeRef.current = t; return t; });
        syncLoopToEngine(tape.loopIn, tape.loopOut, newEnabled);
        break;
      }

      case 'loopFromClip': {
        const sid = selectedClipIdRef.current;
        if (!sid) break;
        const tape = tapeRef.current;
        const clip = tape.lanes[tape.activeLane].clips.find((c) => c.id === sid);
        if (!clip) break;
        pushUndo(tape);
        const loopIn = clip.tapeStart;
        const loopOut = clip.tapeStart + clip.duration;
        setTape((prev) => { const t = { ...prev, loopIn, loopOut, loopEnabled: true }; tapeRef.current = t; return t; });
        syncLoopToEngine(loopIn, loopOut, true);
        break;
      }

      // ── Mixer ───────────────────────────────────────────────────────────────

      case 'setLaneGain': {
        const { lane, gain } = action;
        setTape((prev) => {
          const newLanes = prev.lanes.map((l, i) => i === lane ? { ...l, gain } : l) as [Lane, Lane, Lane, Lane];
          const t = { ...prev, lanes: newLanes };
          tapeRef.current = t;
          engineRef.current?.loadTape(newLanes, poolRef.current);
          return t;
        });
        break;
      }

      case 'setLanePan': {
        const { lane, pan } = action;
        setTape((prev) => {
          const newLanes = prev.lanes.map((l, i) => i === lane ? { ...l, pan } : l) as [Lane, Lane, Lane, Lane];
          const t = { ...prev, lanes: newLanes };
          tapeRef.current = t;
          engineRef.current?.loadTape(newLanes, poolRef.current);
          return t;
        });
        break;
      }

      // ── Settings ───────────────────────────────────────────────────────────

      case 'toggleMode': {
        if (transportRef.current === 'playing' || transportRef.current === 'recording') break;
        setMode((m) => m === 'sync' ? 'free' : 'sync');
        break;
      }

      case 'toggleSnap': {
        setSnap((s) => !s);
        break;
      }

      // ── Session ────────────────────────────────────────────────────────────

      case 'saveSession': {
        const name = sessionNameRef.current.trim();
        if (!name) { setSessionStatus('Enter a session name first'); break; }
        void (async () => {
          try {
            await saveSession(name, tapeRef.current, poolRef.current, modeRef.current, snapRef.current);
            setSessionStatus(`Saved "${name}"`);
            await refreshSessions();
          } catch (err) {
            setSessionStatus(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        })();
        break;
      }

      case 'loadSession': {
        const { name } = action;
        void (async () => {
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
        })();
        break;
      }

      case 'newSession': {
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
        break;
      }

      case 'deleteSession': {
        const { name } = action;
        void (async () => {
          await deleteSession(name);
          await refreshSessions();
          setSessionStatus(`Deleted "${name}"`);
        })();
        break;
      }

      default: {
        // Compile error here means a TapeAction variant is unhandled.
        const _exhaustive: never = action;
        void _exhaustive;
      }
    }
  };

  return { dispatch, refreshSessions };
}
