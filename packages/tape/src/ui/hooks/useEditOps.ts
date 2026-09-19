// Edit operations hook — undo/redo, clip editing, loop points, session CRUD.
import { useCallback } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { Clip, Lane, Tape } from '../../tape/model';
import { AudioPool } from '../../audio/audioPool';
import { makeDefaultTape } from '../../tape/model';
import {
  dropClip,
  joinClips,
  liftClip,
  splitClip,
  tapeLengthFromLanes,
} from '../../tape/editEngine';
import { deleteSession, listSessions, loadSession, saveSession } from '../../tape/session';
import type { TapeEngineRefs, UndoEntry, Mode } from '../tapeRefs';
import { snapshotTape } from '../tapeRefs';

interface EditOpsDeps {
  setTape:          Dispatch<SetStateAction<Tape>>;
  setUndoStack:     Dispatch<SetStateAction<UndoEntry[]>>;
  setRedoStack:     Dispatch<SetStateAction<UndoEntry[]>>;
  setClipboard:     Dispatch<SetStateAction<Clip | null>>;
  setSessions:      Dispatch<SetStateAction<string[]>>;
  setSessionStatus: Dispatch<SetStateAction<string>>;
  setSessionName:   Dispatch<SetStateAction<string>>;
  setMode:          Dispatch<SetStateAction<Mode>>;
  setSnap:          Dispatch<SetStateAction<boolean>>;
  clipboard:        Clip | null;
  sessionName:      string;
}

export function useEditOps(refs: TapeEngineRefs, deps: EditOpsDeps) {
  const {
    engineRef, poolRef, poolDisplayRef, tapeRef, transportRef,
    addLogFnRef, selectedClipIdRef, snapRef, modeRef,
  } = refs;
  const {
    setTape, setUndoStack, setRedoStack, setClipboard,
    setSessions, setSessionStatus, setSessionName, setMode, setSnap,
    clipboard, sessionName,
  } = deps;

  // ---------------------------------------------------------------------------
  // Undo / redo
  // ---------------------------------------------------------------------------
  const pushUndo = useCallback((currentTape: Tape) => {
    setUndoStack((prev) => [...prev, snapshotTape(currentTape)]);
    setRedoStack([]);
  }, [setUndoStack, setRedoStack]);

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
    [pushUndo, setTape],
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
  }, [setUndoStack, setRedoStack, setTape]);

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
  }, [setRedoStack, setUndoStack, setTape]);

  // ---------------------------------------------------------------------------
  // Clip edit operations
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
  }, [applyEdit, setClipboard]);

  const handleDrop = useCallback(() => {
    if (!clipboard) return;
    const currentTape = tapeRef.current;
    const newClips = dropClip(currentTape.lanes[currentTape.activeLane].clips, clipboard, currentTape.playhead);
    applyEdit(currentTape, newClips);
    setTape((prev) => { const t = { ...prev, playhead: currentTape.playhead + clipboard.duration }; tapeRef.current = t; return t; });
  }, [clipboard, applyEdit, setTape]);

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

  // ---------------------------------------------------------------------------
  // Loop operations
  // ---------------------------------------------------------------------------
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
  }, [pushUndo, syncLoopToEngine, setTape]);

  const handleSetLoopOut = useCallback(() => {
    const currentTape = tapeRef.current;
    pushUndo(currentTape);
    setTape((prev) => {
      const t = { ...prev, loopOut: prev.playhead };
      tapeRef.current = t;
      return t;
    });
    syncLoopToEngine(currentTape.loopIn, currentTape.playhead, currentTape.loopEnabled);
  }, [pushUndo, syncLoopToEngine, setTape]);

  const handleToggleLoop = useCallback(() => {
    const currentTape = tapeRef.current;
    const sampleRate = engineRef.current?.sampleRate ?? 44100;
    const newEnabled = !currentTape.loopEnabled;
    const fmt = (s: number) => (s / sampleRate).toFixed(2);
    addLogFnRef.current(`⟳ Loop ${newEnabled ? 'on' : 'off'}  in=${fmt(currentTape.loopIn)}s  out=${fmt(currentTape.loopOut)}s`);
    setTape((prev) => {
      const t = { ...prev, loopEnabled: newEnabled };
      tapeRef.current = t;
      return t;
    });
    syncLoopToEngine(currentTape.loopIn, currentTape.loopOut, newEnabled);
  }, [syncLoopToEngine, setTape]);

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
  }, [pushUndo, syncLoopToEngine, setTape]);

  // ---------------------------------------------------------------------------
  // Session CRUD
  // ---------------------------------------------------------------------------
  const refreshSessions = useCallback(async () => {
    const names = await listSessions();
    setSessions(names);
  }, [setSessions]);

  const handleSave = useCallback(async () => {
    if (!sessionName.trim()) { setSessionStatus('Enter a session name first'); return; }
    try {
      await saveSession(sessionName.trim(), tapeRef.current, poolRef.current, modeRef.current, snapRef.current);
      setSessionStatus(`Saved "${sessionName.trim()}"`);
      await refreshSessions();
    } catch (err) {
      setSessionStatus(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [sessionName, refreshSessions, setSessionStatus]);

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
  }, [setTape, setMode, setSnap, setUndoStack, setRedoStack, setSessionName, setSessionStatus]);

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
  }, [setTape, setClipboard, setUndoStack, setRedoStack, setSessionName, setSessionStatus]);

  const handleDeleteSession = useCallback(async (name: string) => {
    await deleteSession(name);
    await refreshSessions();
    setSessionStatus(`Deleted "${name}"`);
  }, [refreshSessions, setSessionStatus]);

  return {
    pushUndo,
    applyEdit,
    handleUndo,
    handleRedo,
    handleSplit,
    handleLift,
    handleDrop,
    handleJoin,
    syncLoopToEngine,
    handleSetLoopIn,
    handleSetLoopOut,
    handleToggleLoop,
    handleLoopFromClip,
    refreshSessions,
    handleSave,
    handleLoad,
    handleNew,
    handleDeleteSession,
  };
}
