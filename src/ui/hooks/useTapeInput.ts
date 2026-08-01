import { useEffect } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { ControlEvent } from '../../sync/opzControlMode';
import { controlEventToAction, keyEventToAction } from '../inputAdapters';
import type { TapeAction } from '../tapeActions';
import type { Mode } from '../tapeRefs';

interface TapeInputOptions {
  active: boolean;
  dispatch: (action: TapeAction) => void;
  modeRef: MutableRefObject<Mode>;
  ctrlModeHandlerRef: MutableRefObject<((event: ControlEvent) => void) | null>;
  setClickEnabled: Dispatch<SetStateAction<boolean>>;
}

export function useTapeInput({
  active,
  dispatch,
  modeRef,
  ctrlModeHandlerRef,
  setClickEnabled,
}: TapeInputOptions): void {
  ctrlModeHandlerRef.current = (event) => {
    if (modeRef.current !== 'sync') return;
    const action = controlEventToAction(event);
    if (action) dispatch(action);
  };

  useEffect(() => {
    if (!active) return;

    let encoderKey: string | null = null;
    let lastMouseX = 0;
    let accumulatedDeltaX = 0;
    const pixelsPerTick = 14;
    const encoderKeys: Record<string, 0 | 1 | 2 | 3> = { q: 0, w: 1, e: 2, f: 3 };
    const isEditable = (target: EventTarget | null) =>
      target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;

    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditable(event.target) || event.repeat || event.metaKey || event.ctrlKey) return;

      const key = event.key.toLowerCase();
      if (key in encoderKeys) {
        encoderKey = key;
        accumulatedDeltaX = 0;
        event.preventDefault();
        return;
      }
      if (key === 'm') {
        setClickEnabled((enabled) => !enabled);
        event.preventDefault();
        return;
      }
      if (event.key === ' ' || event.key === 'Escape') {
        event.preventDefault();
        if (modeRef.current === 'sync') return;
      }
      const action = keyEventToAction(event);
      if (action) dispatch(action);
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === encoderKey) {
        encoderKey = null;
        accumulatedDeltaX = 0;
      }
    };

    const onMouseMove = (event: MouseEvent) => {
      const deltaX = event.clientX - lastMouseX;
      lastMouseX = event.clientX;
      if (!encoderKey) return;
      accumulatedDeltaX += deltaX;
      const ticks = Math.trunc(accumulatedDeltaX / pixelsPerTick);
      if (ticks === 0) return;
      accumulatedDeltaX -= ticks * pixelsPerTick;
      dispatch({ type: 'encoderNudge', index: encoderKeys[encoderKey]!, delta: ticks, shift: event.shiftKey });
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('mousemove', onMouseMove);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('mousemove', onMouseMove);
    };
  }, [active, ctrlModeHandlerRef, dispatch, modeRef, setClickEnabled]);
}