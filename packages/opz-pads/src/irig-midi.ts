export const IRIG_MIDI = {
  padNote: 60,
  ledChannel: 0,
  cc: {
    fader: 96,
    pot1: 94,
    pot2: 95,
    dataPush: 93,
    button1: 90,
    button2: 91,
    data: 92,
  },
  buttonPressed: 127,
  buttonReleased: 0,
  buttonGreenLedCCs: [24, 26],
  padGreenLedCCs: [94, 96, 98, 100, 86, 88, 90, 92, 78, 80, 82, 84, 70, 72, 74, 76],
} as const;

export function flipPadIndex(index: number): number {
  return (3 - Math.floor(index / 4)) * 4 + index % 4;
}

export function isSceneButtonCC(cc: number): boolean {
  return cc === IRIG_MIDI.cc.button1 || cc === IRIG_MIDI.cc.button2;
}
