import { useCallback, useRef, useState } from 'react';

// Standalone activity-log hook — no engine deps.
export function useActivityLog() {
  const activityLogRef = useRef<string[]>([]);
  const [, forceLogUpdate] = useState(0);
  // Stable ref so closures created before the first render (e.g. handleInit)
  // always call the current version of addLog without deps.
  const addLogFnRef = useRef<(msg: string) => void>(() => {});

  const addLog = useCallback((msg: string) => {
    const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
    activityLogRef.current = [...activityLogRef.current.slice(-199), `${ts}  ${msg}`];
    forceLogUpdate((v) => v + 1);
  }, []);
  addLogFnRef.current = addLog;

  return { activityLogRef, addLogFnRef, addLog, forceLogUpdate };
}
