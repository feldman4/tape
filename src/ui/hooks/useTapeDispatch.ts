// useTapeDispatch — single dispatcher absorbing all tape state mutations.
// Replaces useEditOps + useTransport; TapePage imports only this hook.
import { useCallback, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { AudioEngine } from '../../audio/audioEngine';
import { AudioPool } from '../../audio/audioPool';
import { CANVAS_WIDTH } from '../canvasConstants';
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
import { finalizeFreeRecording, finalizeLoopRecording } from '../../tape/recording';
import { createClickWaveform } from '../../audio/clickWaveform';
import { type TapeEngineRefs, type TransportState, type UndoEntry, type Mode, snapshotTape } from '../tapeRefs';
import type { TapeAction } from '../tapeActions';

interface DispatchDeps {
  setTape:          Dispatch<SetStateAction<Tape>>;
  setTransport:     Dispatch<SetStateAction<TransportState>>;
  setUndoStack:     Dispatch<SetStateAction<UndoEntry[]>>;
  setRedoStack:     Dispatch<SetStateAction<UndoEntry[]>>;
  setClipboard:     Dispatch<SetStateAction<Clip | Array<{ clip: Clip; lane: 0|1|2|3 }> | null>>;
  setSessions:      Dispatch<SetStateAction<string[]>>;
  setSessionStatus: Dispatch<SetStateAction<string>>;
  setSessionName:   Dispatch<SetStateAction<string>>;
  setMode:          Dispatch<SetStateAction<Mode>>;
  setSnap:          Dispatch<SetStateAction<boolean>>;
  setLastClipBeats: Dispatch<SetStateAction<number | null>>;
  clipboard:        Clip | Array<{ clip: Clip; lane: 0|1|2|3 }> | null;
  sessionName:      string;
}

export function useTapeDispatch(refs: TapeEngineRefs, deps: DispatchDeps) {
  const {
    engineRef, poolRef, poolDisplayRef,
    tapeRef, transportRef, modeRef, snapRef, outputLatencyMsRef,
    tapeStartForRecordingRef, recordStartWallTimeRef,
    loopRotateTimeoutRef, loopRotatingRef, armedRef,
    cancelCountInRef, addLogFnRef, selectedClipIdRef, viewWidthSamplesRef,
  } = refs;

  const {
    setTape, setTransport, setUndoStack, setRedoStack, setClipboard,
    setSessions, setSessionStatus, setSessionName, setMode, setSnap,
    setLastClipBeats,
  } = deps;

  // Mirror reactive values into refs so dispatch always sees the latest.
  const clipboardRef = useRef<Clip | Array<{ clip: Clip; lane: 0|1|2|3 }> | null>(deps.clipboard);
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
      // In sync mode, tapeStart is set to the snapped beat position when MIDI Start arrived.
      // Use this directly — MIDI Start timing is reliable, so we place audio at the beat with no latency adjustment.
      const adjTapeStart = Math.max(0, tapeStart);
      
      if (tape.loopEnabled && loopLen > 0) {
        // Calculate where the recording actually ended
        const recordingEndSecs = adjTapeStart + (recording.samples.length / sr);
        
        // If recording stopped before loopOut, don't extend the clip to loopOut.
        // Use finalizeFreeRecording instead to preserve audio beyond the recording end.
        if (recordingEndSecs < tape.loopOut) {
          newClip = finalizeFreeRecording(poolRef.current, recording.samples, adjTapeStart, existingClips);
          addLogFnRef.current(`✓ Take (sync+loop-early-stop): ${(recording.samples.length / sr).toFixed(3)}s (stopped at ${recordingEndSecs.toFixed(3)}s, before loop end ${tape.loopOut.toFixed(3)}s)`);
        } else {
          newClip = finalizeLoopRecording(poolRef.current, recording.samples, adjTapeStart, tape.loopIn, tape.loopOut);
          const passes = (recording.samples.length - Math.max(0, tape.loopIn - adjTapeStart)) / loopLen;
          addLogFnRef.current(`✓ Take (sync+loop): ${(recording.samples.length / sr).toFixed(3)}s raw, ${passes.toFixed(2)}x passes`);
        }
        setLastClipBeats(null);
      } else {
        newClip = finalizeFreeRecording(poolRef.current, recording.samples, adjTapeStart, existingClips);
        addLogFnRef.current(`✓ Take (sync): ${(recording.samples.length / sr).toFixed(3)}s`);
        setLastClipBeats(null);
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
        transportRef.current = 'armed';
        setTransport('armed');
        if (modeRef.current === 'free') {
          addLogFnRef.current('⏺ Armed (free) — press Play to record, Shift+Play for count-in');
        } else {
          addLogFnRef.current('⏺ Armed (sync) — waiting for MIDI start to record');
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
        const engine = engineRef.current;
        if (!engine) break;
        const tr = transportRef.current;
        const startSamples = action.startSamples;
        const tape = tapeRef.current;
        const sr = engine.sampleRate;
        // The user hears hardware audio via input monitoring (zero latency).
        // Tape audio takes L_out ms to emerge from the DAC.  So at real time
        // L_out, the user hears hardware at L_out ms into the performance; the
        // tape must also be at startSamples + L_out at that moment.
        const outLatSamples = Math.round(outputLatencyMsRef.current * sr / 1000);
        const playFrom = (from: number) => from + outLatSamples;
        addLogFnRef.current(`▶ MIDI Start  transport=${tr}  pos=${(startSamples / sr).toFixed(3)}s  out-lat=${outputLatencyMsRef.current.toFixed(1)}ms`);

        // Update playhead to the snapped beat position.
        setTape((prev) => { const t = { ...prev, playhead: startSamples }; tapeRef.current = t; return t; });

        if (tr === 'recording') {
          // Finalize the current take, then restart playback from the new beat.
          engine.stopPlayback();
          void finalizeRecordingTake(engine).then(() => {
            const t = tapeRef.current;
            engine.loadTape(t.lanes, poolRef.current);
            engine.play(playFrom(startSamples), { loopIn: t.loopIn, loopOut: t.loopOut, loopEnabled: t.loopEnabled });
            transportRef.current = 'playing';
            setTransport('playing');
          });
          break;
        }

        if (tr === 'counting-in') {
          cancelCountInRef.current?.();
          armedRef.current = false;
        }

        engine.loadTape(tape.lanes, poolRef.current);

        if (armedRef.current) {
          armedRef.current = false;
          tapeStartForRecordingRef.current = startSamples;   // beat position, not compensated
          recordStartWallTimeRef.current = Date.now();
          engine.play(playFrom(startSamples), { loopIn: tape.loopIn, loopOut: tape.loopOut, loopEnabled: tape.loopEnabled });
          engine.startRecording();
          transportRef.current = 'recording';
          setTransport('recording');
        } else {
          // Not armed: start (or restart) plain playback.
          engine.play(playFrom(startSamples), { loopIn: tape.loopIn, loopOut: tape.loopOut, loopEnabled: tape.loopEnabled });
          transportRef.current = 'playing';
          setTransport('playing');
        }
        break;
      }

      case 'midiClockStop': {
        const engine = engineRef.current;
        if (!engine) break;
        const tr = transportRef.current;
        addLogFnRef.current(`⏹ MIDI Stop  transport=${tr}`);
        if (tr === 'recording') {
          engine.stopPlayback();
          void finalizeRecordingTake(engine).then(() => setTransport('idle'));
          transportRef.current = 'idle';
          break;
        }
        if (tr === 'playing') {
          engine.stopPlayback();
          transportRef.current = 'idle';
          setTransport('idle');
          break;
        }
        if (tr === 'counting-in') {
          cancelCountInRef.current?.();
          armedRef.current = false;
          transportRef.current = 'idle';
          setTransport('idle');
          break;
        }
        if (tr === 'armed') {
          armedRef.current = false;
          transportRef.current = 'idle';
          setTransport('idle');
          break;
        }
        // idle → rewind
        {
          const tape = tapeRef.current;
          const rewindPos = tape.loopEnabled ? tape.loopIn : 0;
          setTape((prev) => { const t = { ...prev, playhead: rewindPos }; tapeRef.current = t; return t; });
          addLogFnRef.current(`⏮ Rewind to ${(rewindPos / engine.sampleRate).toFixed(3)}s`);
        }
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
        const spp = viewWidthSamplesRef.current / CANVAS_WIDTH;  // samples per pixel from view width

        if (index === 1 && !shift) {
          if (transportRef.current === 'recording' || transportRef.current === 'armed') break;
          const newPlayhead = snap
            ? Math.max(0, Math.round((Math.round(tape.playhead / spb) - delta) * spb))
            : Math.max(0, Math.round(tape.playhead - delta * spp));
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
        } else if (index === 3 && !shift) {
          const gain = Math.max(0, Math.min(2, tape.recordingGain + delta * 0.02));
          setTape((prev) => {
            const t = { ...prev, recordingGain: gain };
            tapeRef.current = t;
            return t;
          });
          engineRef.current?.setRecordingGain(gain);
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
        
        if (Array.isArray(cb) && cb.length > 0 && 'lane' in cb[0]) {
          // Drop liftAll clipboard: restore clips to their original lanes at playhead position
          type LiftAllItem = { clip: Clip; lane: 0|1|2|3 };
          const items = cb as LiftAllItem[];
          
          let newLanes = tape.lanes.map(l => ({ ...l })) as [Lane, Lane, Lane, Lane];
          let lastClip: Clip | null = null;
          
          for (const { clip, lane } of items) {
            const droppedClip = { ...clip, tapeStart: tape.playhead };
            newLanes[lane] = { ...newLanes[lane], clips: [...newLanes[lane].clips, droppedClip] };
            lastClip = droppedClip;
          }
          
          const newTape: Tape = { ...tape, lanes: newLanes, tapeLength: tapeLengthFromLanes(newLanes) };
          setTape(newTape);
          tapeRef.current = newTape;
          engineRef.current?.loadTape(newLanes, poolRef.current);
          
          if (lastClip) {
            setTape((prev) => { const t = { ...prev, playhead: lastClip!.tapeStart + lastClip!.duration }; tapeRef.current = t; return t; });
          }
        } else if (Array.isArray(cb)) {
          // Shouldn't happen, but fallback to old behavior
          break;
        } else {
          // Drop single clip at current playhead
          const newClips = dropClip(tape.lanes[tape.activeLane].clips, cb, tape.playhead);
          const dropped = newClips[newClips.length - 1]!;
          applyEdit(tape, newClips);
          setTape((prev) => { const t = { ...prev, playhead: dropped.tapeStart + dropped.duration }; tapeRef.current = t; return t; });
        }
        break;
      }

      case 'liftAll': {
        const tape = tapeRef.current;
        if (!tape.loopEnabled) break; // No-op if loop is not active
        
        pushUndo(tape);
        const loopStart = Math.min(tape.loopIn, tape.loopOut);
        const loopEnd = Math.max(tape.loopIn, tape.loopOut);
        
        // Collect clipped portions and handle splitting at loop boundaries
        const liftedClips: Array<{ clip: Clip; lane: 0|1|2|3 }> = [];
        const newLanes = tape.lanes.map((lane, laneIdx) => {
          if (lane.muted) return lane;
          
          const newClips: Clip[] = [];
          
          for (const clip of lane.clips) {
            const clipStart = clip.tapeStart;
            const clipEnd = clip.tapeStart + clip.duration;
            
            // No overlap with loop - keep clip as-is
            if (clipEnd <= loopStart || clipStart >= loopEnd) {
              newClips.push(clip);
              continue;
            }
            
            // Overlap: split into before, during, after
            const duringStart = Math.max(clipStart, loopStart);
            const duringEnd = Math.min(clipEnd, loopEnd);
            
            // Before portion (clipStart to loopStart)
            if (clipStart < loopStart && loopStart < clipEnd) {
              const beforeClip: Clip = {
                ...clip,
                duration: loopStart - clipStart,
                // sourceStart stays the same
              };
              newClips.push(beforeClip);
            }
            
            // During portion (lift this)
            if (duringStart < duringEnd) {
              const duringClip: Clip = {
                ...clip,
                tapeStart: duringStart,
                sourceStart: clip.sourceStart + (duringStart - clipStart),
                duration: duringEnd - duringStart,
              };
              liftedClips.push({ clip: duringClip, lane: laneIdx as 0|1|2|3 });
            }
            
            // After portion (clipEnd to afterStart)
            if (loopEnd < clipEnd && clipStart < loopEnd) {
              const afterClip: Clip = {
                ...clip,
                tapeStart: loopEnd,
                sourceStart: clip.sourceStart + (loopEnd - clipStart),
                duration: clipEnd - loopEnd,
              };
              newClips.push(afterClip);
            }
          }
          
          return { ...lane, clips: newClips };
        }) as [Lane, Lane, Lane, Lane];
        
        if (liftedClips.length === 0) break; // Nothing to lift
        
        const newTape: Tape = { ...tape, lanes: newLanes, tapeLength: tapeLengthFromLanes(newLanes) };
        setTape(newTape);
        tapeRef.current = newTape;
        engineRef.current?.loadTape(newLanes, poolRef.current);
        setClipboard(liftedClips);
        break;
      }

      case 'mergeDrop': {
        const cb = clipboardRef.current;
        if (!Array.isArray(cb) || cb.length === 0) break;
        
        type LiftAllItem = { clip: Clip; lane: 0|1|2|3 };
        if (!('lane' in cb[0])) break; // Only works with liftAll format
        
        const items = cb as LiftAllItem[];
        const tape = tapeRef.current;
        const loopStart = Math.min(tape.loopIn, tape.loopOut);
        const loopEnd = Math.max(tape.loopIn, tape.loopOut);
        const loopDuration = loopEnd - loopStart;
        
        // Create merged buffer by mixing all lifted clips
        const mergedSamples = new Float32Array(loopDuration);
        let hasAudio = false;
        
        for (const { clip, lane } of items) {
          const buffer = poolRef.current.get(clip.audioBufferId);
          if (!buffer) continue;
          hasAudio = true;
          
          // Map clip position within loop region to merged buffer position
          const clipStartInLoop = Math.max(0, clip.tapeStart - loopStart);
          const clipEndInLoop = Math.min(loopDuration, clip.tapeStart + clip.duration - loopStart);
          const startInClip = Math.max(0, loopStart - clip.tapeStart) + clip.sourceStart;
          
          for (let i = clipStartInLoop; i < clipEndInLoop; i++) {
            const sourceIdx = startInClip + (i - clipStartInLoop);
            if (sourceIdx >= 0 && sourceIdx < buffer.length) {
              // Apply clip gain and tape lane gain
              const laneGain = tape.lanes[lane].gain;
              mergedSamples[i] += buffer[sourceIdx] * clip.gain * laneGain;
            }
          }
        }
        
        if (!hasAudio) break;
        
        // Add merged buffer to pool and create new clip
        const mergedBufferId = poolRef.current.add(mergedSamples);
        poolDisplayRef.current = poolRef.current;
        
        const mergedClip: Clip = {
          id: `clip-${Date.now()}-merged`,
          audioBufferId: mergedBufferId,
          tapeStart: tape.playhead,
          sourceStart: 0,
          duration: loopDuration,
          gain: 1.0,
          muted: false,
        };
        
        // Drop merged clip on active lane at playhead
        const newClips = dropClip(tape.lanes[tape.activeLane].clips, mergedClip, tape.playhead);
        applyEdit(tape, newClips);
        setTape((prev) => { const t = { ...prev, playhead: tape.playhead + mergedClip.duration }; tapeRef.current = t; return t; });
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

      case 'setRecordingGain': {
        const gain = Math.max(0, Math.min(2, action.gain));
        setTape((prev) => {
          const t = { ...prev, recordingGain: gain };
          tapeRef.current = t;
          return t;
        });
        engineRef.current?.setRecordingGain(gain);
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
            engineRef.current?.setRecordingGain(result.tape.recordingGain);
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
        engineRef.current?.setRecordingGain(freshTape.recordingGain);
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
