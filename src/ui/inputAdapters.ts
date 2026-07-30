// Input adapters — pure functions mapping device-specific events to TapeActions.
// No refs, no side effects. The adapter layer is the boundary between
// "what the device did" and "what the user intends".
import type { ControlEvent } from '../sync/opzControlMode';
import type { TapeAction } from './tapeActions';

/**
 * Maps OP-Z ControlEvents to TapeActions.
 * Resolves shift combos into semantic actions (e.g. split+shift → join).
 * Returns null for events with no tape-machine intent (e.g. shiftChange).
 */
export function controlEventToAction(event: ControlEvent): TapeAction | null {
  switch (event.type) {
    case 'record':     return { type: 'record' };
    case 'play':       return { type: 'play', countIn: event.shift };
    case 'stop':       return { type: 'stop' };
    case 'lift':       return event.shift ? { type: 'liftAll' } : { type: 'lift' };
    case 'drop':       return event.shift ? { type: 'mergeDrop' } : { type: 'drop' };
    case 'split':      return event.shift ? { type: 'join' } : { type: 'split' };
    case 'loopIn':     return { type: 'setLoopIn' };
    case 'loopOut':    return { type: 'setLoopOut' };
    case 'loopToggle': return event.shift ? { type: 'loopFromClip' } : { type: 'toggleLoop' };
    case 'selectLane': return event.shift
      ? { type: 'toggleMuteLane', lane: event.lane }
      : { type: 'selectLane',     lane: event.lane };
    case 'encoderDelta': return {
      type: 'encoderNudge',
      index: event.index,
      delta: event.delta,
      shift: event.shift,
    };
    case 'shiftChange': return null;
  }
}

/**
 * Maps keyboard events to TapeActions.
 * Returns null for unrecognised keys (caller should not preventDefault).
 * Encoder keys (q/w/e/f) are NOT handled here — they require mouse-tracking
 * state and are managed in the keyboard useEffect directly.
 */
export function keyEventToAction(ev: KeyboardEvent): TapeAction | null {
  const shift = ev.shiftKey;
  switch (ev.key) {
    case '1': case '!': return shift ? { type: 'toggleMuteLane', lane: 0 } : { type: 'selectLane', lane: 0 };
    case '2': case '@': return shift ? { type: 'toggleMuteLane', lane: 1 } : { type: 'selectLane', lane: 1 };
    case '3': case '#': return shift ? { type: 'toggleMuteLane', lane: 2 } : { type: 'selectLane', lane: 2 };
    case '4': case '$': return shift ? { type: 'toggleMuteLane', lane: 3 } : { type: 'selectLane', lane: 3 };
    case 'r': case 'R': return { type: 'record' };
    case ' ':           return { type: 'play', countIn: shift };
    case 'Escape':      return { type: 'stop' };
    case '[':           return { type: 'setLoopIn' };
    case ']':           return { type: 'setLoopOut' };
    case '\\':          return shift ? { type: 'loopFromClip' } : { type: 'toggleLoop' };
    case 'l': case 'L': return shift ? { type: 'liftAll' } : { type: 'lift' };
    case 'd': case 'D': return shift ? { type: 'mergeDrop' } : { type: 'drop' };
    case 'z': case 'Z': return shift ? { type: 'redo' } : { type: 'undo' };
    case 'o': case 'O': return { type: 'toggleMode' };
    case 'x': case 'X': return { type: 'toggleSnap' };
    case 's': case 'S': return shift ? { type: 'join' } : { type: 'split' };
    default:            return null;
  }
}
