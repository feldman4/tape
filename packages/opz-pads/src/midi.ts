import { flipPadIndex, IRIG_MIDI, isSceneButtonCC } from './irig-midi.ts';

export type MidiEvent =
  | { type: 'note'; channel: number; note: number; velocity: number; on: boolean }
  | { type: 'control'; channel: number; controller: number; value: number }
  | { type: 'program'; channel: number; program: number }
  | { type: 'pressure'; channel: number; value: number }
  | { type: 'transport'; state: 'running' | 'stopped' };

export type IrigEvent =
  | { type: 'pad'; index: number; on: boolean; velocity: number }
  | { type: 'pressure'; index: number; value: number }
  | { type: 'button'; index: 0 | 1; pressed: boolean }
  | { type: 'push'; pressed: boolean }
  | { type: 'control'; control: typeof IRIG_MIDI.cc.fader; value: number; scene: number }
  | { type: 'control'; control: Exclude<Control, typeof IRIG_MIDI.cc.fader>; value: number };
export type Control = typeof IRIG_MIDI.cc.fader | typeof IRIG_MIDI.cc.data |
  typeof IRIG_MIDI.cc.pot1 | typeof IRIG_MIDI.cc.pot2;

export function decodeMidi(data: ArrayLike<number>): MidiEvent | null {
  const status = data[0];
  if (status === undefined) return null;
  if (status === 0xfa || status === 0xfb || status === 0xfc) {
    return { type: 'transport', state: status === 0xfc ? 'stopped' : 'running' };
  }
  const kind = status & 0xf0;
  const channel = status & 15;
  const a = data[1];
  const b = data[2];
  if (kind === 0xc0 && a !== undefined) return { type: 'program', channel, program: a };
  if (kind === 0xd0 && a !== undefined) return { type: 'pressure', channel, value: a };
  if ((kind === 0x80 || kind === 0x90) && a !== undefined && b !== undefined) {
    return { type: 'note', channel, note: a, velocity: b, on: kind === 0x90 && b > 0 };
  }
  if (kind === 0xb0 && a !== undefined && b !== undefined) {
    return { type: 'control', channel, controller: a, value: b };
  }
  return null;
}

export function decodeIrig(data: ArrayLike<number>): IrigEvent | null {
  const event = decodeMidi(data);
  if (!event) return null;
  if (event.type === 'note' && event.note === IRIG_MIDI.padNote) {
    return { type: 'pad', index: flipPadIndex(event.channel), on: event.on, velocity: event.velocity };
  }
  if (event.type === 'pressure') return { type: 'pressure', index: flipPadIndex(event.channel), value: event.value };
  if (event.type !== 'control') return null;
  const { controller, value } = event;
  if (isSceneButtonCC(controller) && (value === IRIG_MIDI.buttonReleased || value === IRIG_MIDI.buttonPressed)) {
    return { type: 'button', index: controller === IRIG_MIDI.cc.button1 ? 0 : 1, pressed: value === IRIG_MIDI.buttonPressed };
  }
  if (controller === IRIG_MIDI.cc.dataPush && (value === IRIG_MIDI.buttonPressed || value === IRIG_MIDI.buttonReleased)) {
    return { type: 'push', pressed: value === IRIG_MIDI.buttonPressed };
  }
  if (controller === IRIG_MIDI.cc.fader) return { type: 'control', control: controller, value, scene: flipPadIndex(event.channel) };
  if (controller === IRIG_MIDI.cc.data || controller === IRIG_MIDI.cc.pot1 || controller === IRIG_MIDI.cc.pot2) {
    return { type: 'control', control: controller, value };
  }
  return null;
}
