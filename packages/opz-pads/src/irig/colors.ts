import type { DrumChannel } from '../project/model.ts';

export type Led = [red: number, green: number];

const clamp = (value: number): number => Math.max(0, Math.min(127, Math.round(value)));

export const off: Led = [0, 0];
export const groupSelected: Led = [127, 35];
export const groupOther: Led = [7, 5];
export const drumColors: Record<DrumChannel, Led> = {
  0: [127, 100], 1: [127, 0], 2: [127, 35], 3: [0, 127], 12: [0, 127],
};
export const ledTestColors: Led[] = [[0, 32], [0, 127], [32, 96], [64, 64], [96, 32], [127, 0], [32, 0], off];

export function drumLed(channel: DrumChannel, held: boolean): Led {
  const factor = held ? 1 : 0.45;
  const [red, green] = drumColors[channel];
  return [Math.round(red * factor), Math.round(green * factor)];
}

export function mixerScaleLed(value: number): Led {
  const scale = value / 127;
  const brightness = 19 + 108 * scale;
  const orange = Math.min(1, 2 * (1 - scale));
  const redBrightness = 7 + (brightness - 19) / 2;
  return [clamp(redBrightness * orange), clamp(brightness * (1 - orange * (1 - 35 / 127)))];
}

export function mixerLevelLed(value: number, muted: boolean): Led {
  return [0, Math.max(muted ? 0 : 16, value)];
}

export function mixerPanLed(value: number): Led {
  return [clamp((127 - value) / 2), value];
}

export function fxLed(type: 'note' | 'custom' | 'scene', depth: number): Led {
  const brightness = Math.round(20 + 107 * depth);
  return type === 'note' ? [0, brightness] : type === 'custom' ? [brightness, 0] :
    [brightness, Math.round(brightness * 35 / 127)];
}

export const gradients: { name: string; color: (value: number) => Led }[] = [
  { name: 'Mixer fader scale', color: mixerScaleLed },
  { name: 'Mixer level (active or unknown)', color: (value) => mixerLevelLed(value, false) },
  { name: 'Mixer level (muted)', color: (value) => mixerLevelLed(value, true) },
  { name: 'Mixer pan', color: mixerPanLed },
  { name: 'FX note pressure', color: (value) => fxLed('note', value / 127) },
  { name: 'FX custom pressure', color: (value) => fxLed('custom', value / 127) },
  { name: 'FX scene depth', color: (value) => fxLed('scene', value / 127) },
];

export const palette: { name: string; color: Led }[] = [
  { name: 'Off', color: off },
  { name: 'Mute group selected', color: groupSelected },
  { name: 'Mute group other', color: groupOther },
  ...([['Kick', 0], ['Snare', 1], ['Hi-hat', 2], ['Sample / FX', 3]] as const).flatMap(([name, channel]) => [
    { name: `Drum ${name} (dim)`, color: drumLed(channel, false) },
    { name: `Drum ${name} (held)`, color: drumLed(channel, true) },
  ]),
  ...ledTestColors.map((color, index) => ({ name: `LED test ${index + 1}`, color })),
];
