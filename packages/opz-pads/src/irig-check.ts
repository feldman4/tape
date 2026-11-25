import { decodeIrig, decodeMidi } from './midi.ts';
import { IRIG_MIDI, isSceneButtonCC } from './irig-midi.ts';

export type Step = 'scene' | 'pads' | 'simultaneous' | 'controls' | 'gestures' | 'leds';
type PadPhase = 'press' | 'pressure' | 'release';
type CheckState = {
  step: Step;
  scene: number;
  sceneSeen: boolean;
  scenePressed: 0 | 1 | null;
  pad: number;
  padPhase: PadPhase;
  simultaneous: number;
  control: number;
  pressed: boolean;
  gesture: number;
  ledComplete: boolean;
  ledRunning: boolean;
  ledSent: boolean;
  ledError: string;
  last: string;
};

export const controls = [
  { label: 'Pot 1', cc: IRIG_MIDI.cc.pot1, kind: 'absolute' },
  { label: 'Pot 2', cc: IRIG_MIDI.cc.pot2, kind: 'absolute' },
  { label: 'Fader', cc: IRIG_MIDI.cc.fader, kind: 'absolute' },
  { label: 'DATA clockwise', cc: IRIG_MIDI.cc.data, kind: 'positive' },
  { label: 'DATA counterclockwise', cc: IRIG_MIDI.cc.data, kind: 'negative' },
  { label: 'Button 1', cc: IRIG_MIDI.cc.button1, kind: 'button' },
  { label: 'Button 2', cc: IRIG_MIDI.cc.button2, kind: 'button' },
  { label: 'DATA push', cc: IRIG_MIDI.cc.dataPush, kind: 'button' },
] as const;

export const gestures = [
  { instruction: 'Press and hold pad 1.', type: 'note', on: true },
  { instruction: 'Keep pad 1 held and press button 1.', type: 'control', cc: IRIG_MIDI.cc.button1, value: 'on' },
  { instruction: 'Keep both held and turn pot 1.', type: 'control', cc: IRIG_MIDI.cc.pot1, value: 'any' },
  { instruction: 'Release button 1, keeping pad 1 held.', type: 'control', cc: IRIG_MIDI.cc.button1, value: 'off' },
  { instruction: 'Release pad 1.', type: 'note', on: false },
  { instruction: 'Press and hold pad 1.', type: 'note', on: true },
  { instruction: 'Keep pad 1 held and press button 2.', type: 'control', cc: IRIG_MIDI.cc.button2, value: 'on' },
  { instruction: 'Keep both held and turn pot 2.', type: 'control', cc: IRIG_MIDI.cc.pot2, value: 'any' },
  { instruction: 'Release button 2, keeping pad 1 held.', type: 'control', cc: IRIG_MIDI.cc.button2, value: 'off' },
  { instruction: 'Release pad 1.', type: 'note', on: false },
  { instruction: 'Press and hold DATA push.', type: 'control', cc: IRIG_MIDI.cc.dataPush, value: 'on' },
  { instruction: 'Keep DATA push held and turn DATA clockwise.', type: 'control', cc: IRIG_MIDI.cc.data, value: 'positive' },
  { instruction: 'Keep DATA push held and turn DATA counterclockwise.', type: 'control', cc: IRIG_MIDI.cc.data, value: 'negative' },
  { instruction: 'Release DATA push.', type: 'control', cc: IRIG_MIDI.cc.dataPush, value: 'off' },
] as const;

export const initialCheck: CheckState = {
  step: 'scene', scene: 1, sceneSeen: false, scenePressed: null, pad: 0, padPhase: 'press',
  simultaneous: 0, control: 0, pressed: false, gesture: 0,
  ledComplete: false, ledRunning: false, ledSent: false, ledError: '', last: 'No MIDI received yet.',
};

type Action =
  | { type: 'midi'; bytes: number[] }
  | { type: 'scene'; scene: number }
  | { type: 'select'; step: Step }
  | { type: 'restart-check' }
  | { type: 'led-start' }
  | { type: 'led-sent' }
  | { type: 'led-error'; message: string }
  | { type: 'led-confirm' };

export function checkReducer(state: CheckState, action: Action): CheckState {
  switch (action.type) {
    case 'scene':
      return action.scene === state.scene ? state : { ...initialCheck, step: state.step, scene: action.scene, last: state.last };
    case 'select':
      if (action.step === state.step) return state;
      return {
        ...state, step: action.step, scenePressed: null, padPhase: 'press', pressed: false,
        simultaneous: state.simultaneous === 4 ? 4 : 0,
        gesture: state.gesture === gestures.length ? state.gesture : state.gesture < 5 ? 0 : state.gesture < 10 ? 5 : 10,
        ledRunning: false, ledSent: false, ledError: '',
      };
    case 'restart-check':
      switch (state.step) {
        case 'scene': return { ...state, sceneSeen: false, scenePressed: null };
        case 'pads': return { ...state, pad: 0, padPhase: 'press' };
        case 'simultaneous': return { ...state, simultaneous: 0 };
        case 'controls': return { ...state, control: 0, pressed: false };
        case 'gestures': return { ...state, gesture: 0 };
        case 'leds': return { ...state, ledComplete: false, ledRunning: false, ledSent: false, ledError: '' };
      }
    case 'led-start':
      return state.step === 'leds' && !state.ledRunning
        ? { ...state, ledComplete: false, ledRunning: true, ledSent: false, ledError: '' } : state;
    case 'led-sent':
      return state.step === 'leds' && state.ledRunning ? { ...state, ledRunning: false, ledSent: true, ledError: '' } : state;
    case 'led-error':
      return { ...state, ledRunning: false, ledSent: false, ledError: action.message };
    case 'led-confirm':
      if (state.step !== 'leds' || !state.ledSent) return state;
      return { ...state, ledComplete: true, ledSent: false };
    case 'midi': {
      const event = decodeMidi(action.bytes);
      const irig = decodeIrig(action.bytes);
      const last = action.bytes.map((byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join(' ');
      const next = { ...state, last: `Hex: ${last}${event ? ` | ${JSON.stringify(event)}` : ' | unsupported message'}` };
      if (!event) return next;
      if (irig && 'scene' in irig && irig.scene !== state.scene - 1) {
        return { ...initialCheck, scene: state.scene, last: `${next.last} | Different scene detected; checks reset.` };
      }
      if (state.step === 'scene' && irig?.type === 'button') {
        if (irig.pressed) return { ...next, scenePressed: irig.index };
        return { ...next, sceneSeen: state.sceneSeen || state.scenePressed === irig.index, scenePressed: null };
      }
      if (state.step === 'pads' && state.pad < 16) {
        if (state.padPhase === 'press' && event.type === 'note' && event.channel === state.pad && event.note === IRIG_MIDI.padNote && event.on) {
          return { ...next, padPhase: 'pressure' };
        }
        if (state.padPhase === 'pressure' && event.type === 'pressure' && event.channel === state.pad) {
          return { ...next, padPhase: 'release' };
        }
        if (state.padPhase === 'release' && event.type === 'note' && event.channel === state.pad && event.note === IRIG_MIDI.padNote && !event.on) {
          return { ...next, pad: state.pad + 1, padPhase: 'press' };
        }
        if (state.padPhase === 'pressure' && event.type === 'note' && event.channel === state.pad && event.note === IRIG_MIDI.padNote && !event.on) {
          return { ...next, padPhase: 'press' };
        }
      }
      if (state.step === 'simultaneous' && state.simultaneous < 4 && event.type === 'note' && event.note === IRIG_MIDI.padNote) {
        const expected = [
          { channel: 0, on: true }, { channel: 1, on: true },
          { channel: 0, on: false }, { channel: 1, on: false },
        ][state.simultaneous];
        if (event.channel === expected.channel && event.on === expected.on) {
          return { ...next, simultaneous: state.simultaneous + 1 };
        }
        if (!event.on && state.simultaneous < 2) return { ...next, simultaneous: 0 };
      }
      if (state.step === 'controls' && state.control < controls.length && event.type === 'control') {
        const control = controls[state.control];
        if (event.controller !== control.cc || event.channel !== state.scene - 1 ||
          (isSceneButtonCC(control.cc) && irig?.type !== 'button') ||
          (control.cc === IRIG_MIDI.cc.dataPush && irig?.type !== 'push')) return next;
        if (control.kind === 'button') {
          if (event.value > 0) return { ...next, pressed: true };
          if (state.pressed) return { ...next, pressed: false, control: state.control + 1 };
        } else if (control.kind === 'absolute' || (control.kind === 'positive' && event.value > 0 && event.value < 64) ||
          (control.kind === 'negative' && event.value >= 64)) {
          return { ...next, control: state.control + 1 };
        }
      }
      if (state.step === 'gestures' && state.gesture < gestures.length) {
        const expected = gestures[state.gesture];
        const matches = expected.type === 'note'
          ? event.type === 'note' && event.channel === 0 && event.note === IRIG_MIDI.padNote && event.on === expected.on
          : event.type === 'control' && event.channel === state.scene - 1 && event.controller === expected.cc &&
            (!isSceneButtonCC(expected.cc) || irig?.type === 'button') &&
            (expected.cc !== IRIG_MIDI.cc.dataPush || irig?.type === 'push') &&
            (expected.value === 'any' || (expected.value === 'on' && event.value > 0) ||
              (expected.value === 'off' && event.value === 0) ||
              (expected.value === 'positive' && event.value > 0 && event.value < 64) ||
              (expected.value === 'negative' && event.value >= 64));
        if (matches) return { ...next, gesture: state.gesture + 1 };
        const start = state.gesture < 5 ? 0 : state.gesture < 10 ? 5 : 10;
        if (state.gesture > start && ((event.type === 'note' && event.channel === 0 && event.note === IRIG_MIDI.padNote && !event.on) ||
          (event.type === 'control' && event.value === 0 &&
            event.controller === (start === 0 ? IRIG_MIDI.cc.button1 : start === 5 ? IRIG_MIDI.cc.button2 : IRIG_MIDI.cc.dataPush) &&
            event.channel === state.scene - 1))) {
          return { ...next, gesture: start };
        }
      }
      return next;
    }
  }
}
