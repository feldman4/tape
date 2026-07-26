// Transport hook — record/play/stop/finalize logic.
// The two previously-duplicated doRotation helpers are consolidated here.
import { useCallback } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { AudioEngine } from '../../audio/audioEngine';
import type { Clip, Tape } from '../../tape/model';
import { finalizeFreeRecording, finalizeLoopRecording, finalizeSyncRecording } from '../../tape/recording';
import { applyOverwrite } from '../../tape/editEngine';
import { createClickWaveform } from '../../audio/clickWaveform';
import type { TapeEngineRefs, TransportState } from '../tapeRefs';

interface TransportDeps {
  applyEdit: (currentTape: Tape, newClips: Clip[], extra?: Partial<Tape>) => Tape;
  setTransport: Dispatch<SetStateAction<TransportState>>;
  setTape: Dispatch<SetStateAction<Tape>>;
  setLastClipBeats: Dispatch<SetStateAction<number | null>>;
}

export function useTransport(refs: TapeEngineRefs, deps: TransportDeps) {
  const {
    engineRef, syncEngineRef, poolRef, poolDisplayRef,
    tapeRef, transportRef, modeRef, outputLatencyMsRef,
    tapeStartForRecordingRef, recordStartWallTimeRef,
    loopRotateTimeoutRef, loopRotatingRef, armedRef,
    cancelCountInRef, addLogFnRef,
  } = refs;
  const { applyEdit, setTransport, setTape, setLastClipBeats } = deps;

  // ---------------------------------------------------------------------------
  // Loop rotation helper — starts per-pass recording rotation at each loop
  // boundary.  Consolidates the two formerly-duplicated doRotation helpers.
  // ---------------------------------------------------------------------------
  const startLoopRotation = useCallback((
    firstPassStart: number,
    firstWallTime: number,
  ) => {
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
          const newClips = applyOverwrite(existing, clip);
          applyEdit(tapeRef.current, newClips);
          addLogFnRef.current(`↻ Loop pass: ${(rec.samples.length / sr).toFixed(3)}s`);
        }
        tapeStartForRecordingRef.current = loopIn;
        doRotation(loopIn, wallTime + (loopOut - loopIn) / eng.sampleRate * 1000);
      }, Math.max(0, wallTime - Date.now()));
    };
    doRotation(firstPassStart, firstWallTime);
  }, [applyEdit]); // applyEdit is stable; other deps are refs accessed via .current

  // ---------------------------------------------------------------------------
  // finalizeRecordingTake — stop capture, process samples, commit clip.
  // ---------------------------------------------------------------------------
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
      const currentTape = tapeRef.current;
      const loopLen = currentTape.loopOut - currentTape.loopIn;
      const outputLatencySamples = Math.round(outputLatencyMsRef.current * sr / 1000);
      const adjustedTapeStart = Math.max(0, tapeStart - outputLatencySamples);

      if (wasLoopRotating) {
        if (recording.samples.length === 0) return;
        newClip = finalizeFreeRecording(poolRef.current, recording.samples, adjustedTapeStart, existingClips);
        addLogFnRef.current(`✓ Take (loop-rotate tail): ${(recording.samples.length / sr).toFixed(3)}s`);
      } else if (currentTape.loopEnabled && loopLen > 0) {
        newClip = finalizeLoopRecording(poolRef.current, recording.samples, adjustedTapeStart, currentTape.loopIn, currentTape.loopOut, existingClips);
        const passes = (recording.samples.length - Math.max(0, currentTape.loopIn - adjustedTapeStart)) / loopLen;
        addLogFnRef.current(`✓ Take (loop-overdub): ${(recording.samples.length / sr).toFixed(3)}s raw, ${passes.toFixed(2)}x passes  latency-adj=${outputLatencyMsRef.current.toFixed(1)}ms`);
      } else {
        newClip = finalizeFreeRecording(poolRef.current, recording.samples, adjustedTapeStart, existingClips);
        addLogFnRef.current(`✓ Take (free): ${(recording.samples.length / sr).toFixed(3)}s  latency-adj=${outputLatencyMsRef.current.toFixed(1)}ms`);
      }
      setLastClipBeats(null);
    } else {
      const currentTape = tapeRef.current;
      const loopLen = currentTape.loopOut - currentTape.loopIn;
      const isLoopRec = currentTape.loopEnabled && loopLen > 0;
      if (isLoopRec) {
        newClip = finalizeLoopRecording(poolRef.current, recording.samples, tapeStart, currentTape.loopIn, currentTape.loopOut);
        const passes = (recording.samples.length - Math.max(0, currentTape.loopIn - tapeStart)) / loopLen;
        addLogFnRef.current(`✓ Take (sync+loop): ${(recording.samples.length / sr).toFixed(3)}s raw, ${passes.toFixed(2)}x passes`);
        setLastClipBeats(null);
      } else {
        const syncEngine = syncEngineRef.current;
        const samplesPerBeat = syncEngine?.samplesPerBeat() ?? sr;
        const beatsElapsed = Math.round(recording.samples.length / samplesPerBeat);
        newClip = finalizeSyncRecording(poolRef.current, recording.samples, tapeStart, beatsElapsed, samplesPerBeat);
        const rawSamples = recording.samples.length;
        const targetSamples = Math.max(0, Math.round(beatsElapsed * samplesPerBeat));
        const corrSamples = targetSamples - rawSamples;
        addLogFnRef.current(`✓ Take (sync): raw=${(rawSamples / sr).toFixed(3)}s  correction=${(corrSamples / sr * 1000).toFixed(1)}ms  beats=${beatsElapsed}`);
        setLastClipBeats(beatsElapsed);
      }
    }

    poolDisplayRef.current = poolRef.current;
    const newClips = applyOverwrite(existingClips, newClip);
    applyEdit(tapeRef.current, newClips);
  }, [applyEdit, setLastClipBeats]);

  // ---------------------------------------------------------------------------
  // handleRecord
  // ---------------------------------------------------------------------------
  const handleRecord = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine) return;
    const currentTransport = transportRef.current;
    addLogFnRef.current(`⏺ Record  transport=${currentTransport}  mode=${modeRef.current}`);

    if (currentTransport === 'recording') {
      await finalizeRecordingTake(engine);
      transportRef.current = 'playing';
      setTransport('playing');
      return;
    }

    if (currentTransport === 'counting-in') {
      cancelCountInRef.current?.();
      armedRef.current = false;
      transportRef.current = 'idle';
      setTransport('idle');
      addLogFnRef.current('→ count-in cancelled');
      return;
    }

    if (currentTransport === 'playing') {
      const currentTape = tapeRef.current;
      tapeStartForRecordingRef.current = currentTape.playhead;
      recordStartWallTimeRef.current = Date.now();
      engine.startRecording();
      if (modeRef.current === 'free' && currentTape.loopEnabled && currentTape.loopOut > currentTape.loopIn) {
        const sr0 = engine.sampleRate;
        const firstWall = Date.now() + Math.max(0, (currentTape.loopOut - currentTape.playhead) / sr0 * 1000);
        startLoopRotation(currentTape.playhead, firstWall);
      }
      transportRef.current = 'recording';
      setTransport('recording');
      addLogFnRef.current(`⏺ Recording started at ${(currentTape.playhead / engine.sampleRate).toFixed(3)}s`);
      return;
      // Second press cancels arm (unreachable; preserved for documentation).
      armedRef.current = false;
      transportRef.current = 'idle';
      setTransport('idle');
      addLogFnRef.current('→ arm cancelled');
      return;
    }

    // idle → arm
    if (modeRef.current === 'free') {
      armedRef.current = true;
      transportRef.current = 'armed';
      setTransport('armed');
      addLogFnRef.current('⏺ Armed (free) — press Play to record, Shift+Play for count-in');
    } else {
      armedRef.current = true;
      setTransport('armed');
    }
  }, [finalizeRecordingTake, startLoopRotation, setTransport]);

  // ---------------------------------------------------------------------------
  // handleStop
  // ---------------------------------------------------------------------------
  const handleStop = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine) return;
    const currentTransport = transportRef.current;
    addLogFnRef.current(`⏹ Stop  transport=${currentTransport}`);

    if (currentTransport === 'idle') {
      const currentTape = tapeRef.current;
      const rewindPos = currentTape.loopEnabled ? currentTape.loopIn : 0;
      setTape((prev) => { const t = { ...prev, playhead: rewindPos }; tapeRef.current = t; return t; });
      addLogFnRef.current(`⏮ Rewind to ${(rewindPos / engine.sampleRate).toFixed(3)}s`);
      return;
    }
    if (currentTransport === 'playing') {
      engine.stopPlayback();
      setTransport('idle');
      addLogFnRef.current('⏸ Pause');
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
  }, [finalizeRecordingTake, setTransport, setTape]);

  // ---------------------------------------------------------------------------
  // handlePlay
  // ---------------------------------------------------------------------------
  const handlePlay = useCallback(async (withCountIn = false) => {
    const engine = engineRef.current;
    if (!engine) return;
    const currentTransport = transportRef.current;

    if (currentTransport === 'recording') {
      await finalizeRecordingTake(engine);
      engine.stopPlayback();
      armedRef.current = true;
      transportRef.current = 'armed';
      setTransport('armed');
      addLogFnRef.current('⏺ Take finalized — re-armed');
      return;
    }

    if (currentTransport === 'playing') {
      engine.stopPlayback();
      setTransport('idle');
      addLogFnRef.current('⏸ Pause');
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
        if (currentTape.loopEnabled && currentTape.loopOut > currentTape.loopIn) {
          const sr0 = engine.sampleRate;
          const firstWall = Date.now() + Math.max(0, (currentTape.loopOut - currentTape.playhead) / sr0 * 1000);
          startLoopRotation(currentTape.playhead, firstWall);
        }
        transportRef.current = 'recording';
        setTransport('recording');
        addLogFnRef.current(`⏺ Recording started at ${(currentTape.playhead / engine.sampleRate).toFixed(3)}s`);
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
      addLogFnRef.current(`⏺ Count-in: ${bpm.toFixed(0)} BPM, ${(countInMs / 1000).toFixed(2)}s`);
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
    addLogFnRef.current(`▶ Play  playhead=${(currentTape.playhead / engine.sampleRate).toFixed(3)}s`);
    engine.loadTape(currentTape.lanes, poolRef.current);
    engine.play(currentTape.playhead, {
      loopIn: currentTape.loopIn,
      loopOut: currentTape.loopOut,
      loopEnabled: currentTape.loopEnabled,
    });
    setTransport('playing');
  }, [finalizeRecordingTake, startLoopRotation, setTransport]);

  return { finalizeRecordingTake, handleRecord, handleStop, handlePlay };
}
