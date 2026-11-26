import type { Control } from './midi.ts';
import { IRIG_MIDI } from './irig-midi.ts';

export class ControllerState {
  readonly held = Array<boolean>(16).fill(false);
  readonly pressure = Array<number>(16).fill(0);
  readonly buttons: [boolean, boolean] = [false, false];
  readonly pots: [number | null, number | null] = [null, null];
  push = false;
  fader = 127;
  private readonly controls = new Map<Control, number>();

  release(): void {
    this.held.fill(false);
    this.pressure.fill(0);
    this.buttons.fill(false);
    this.push = false;
  }

  resetControls(): void {
    this.controls.clear();
  }

  button(index: 0 | 1, pressed: boolean): void {
    if (!pressed) this.buttons[index] = false;
    else if (!this.buttons[1 - index]) this.buttons[index] = true;
  }

  move(control: Control, value: number): number {
    if (control === IRIG_MIDI.cc.fader) this.fader = value;
    if (control === IRIG_MIDI.cc.pot1) this.pots[0] = value;
    if (control === IRIG_MIDI.cc.pot2) this.pots[1] = value;
    const previous = this.controls.get(control);
    this.controls.set(control, value);
    return control === IRIG_MIDI.cc.data ? (value >= 64 ? value - 128 : value) : previous === undefined ? 0 : value - previous;
  }
}
