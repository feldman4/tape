export type MidiEvent =
  | { type: 'note'; channel: number; note: number; velocity: number; on: boolean }
  | { type: 'control'; channel: number; controller: number; value: number }
  | { type: 'program'; channel: number; program: number }
  | { type: 'pressure'; channel: number; value: number }
  | { type: 'transport'; state: 'running' | 'stopped' };

export type IrigEvent =
  | { type: 'scene'; index: number }
  | { type: 'pad'; index: number; on: boolean; velocity: number }
  | { type: 'pressure'; index: number; value: number }
  | { type: 'button'; index: 0 | 1; pressed: boolean }
  | { type: 'push'; pressed: boolean }
  | { type: 'control'; control: Control; value: number };
export type Control = 1 | 7 | 10 | 11;

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
  if (event.type === 'program' && event.program < 16) return { type: 'scene', index: event.program };
  if (event.type === 'note' && event.note === 48) {
    return { type: 'pad', index: event.channel, on: event.on, velocity: event.velocity };
  }
  if (event.type === 'pressure') return { type: 'pressure', index: event.channel, value: event.value };
  if (event.type !== 'control' || event.channel !== 0) return null;
  const { controller, value } = event;
  if (controller === 20 || controller === 21) {
    return { type: 'button', index: controller === 20 ? 0 : 1, pressed: value > 0 };
  }
  if (controller === 22) return { type: 'push', pressed: value > 0 };
  if (controller === 1 || controller === 7 || controller === 10 || controller === 11) {
    return { type: 'control', control: controller, value };
  }
  return null;
}
