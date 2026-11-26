import type { ControllerState } from './controller.ts';
import { IRIG_MIDI } from '../irig/midi.ts';
import type { MixerScene } from '../project/model.ts';
import type { Led, SceneEvent, SceneHandler, Send } from './scenes.ts';
import type { MidiEvent } from '../midi/midi.ts';
import { groupOther, groupSelected, mixerLevelLed, mixerPanLed, mixerScaleLed, off } from '../irig/colors.ts';

const clamp = (value: number): number => Math.max(0, Math.min(127, Math.round(value)));
const displayTimeout = 1000;

export class MixerHandler implements SceneHandler<MixerScene> {
  readonly levels: (number | null)[] = Array(16).fill(null);
  readonly pans: (number | null)[] = Array(16).fill(null);
  readonly muted: (boolean | null)[] = Array(16).fill(null);
  readonly groups: (boolean | null)[][] = Array.from({ length: 10 }, () => Array(16).fill(null));
  group = 0;
  readonly baseLevels: (number | null)[] = Array(16).fill(null);
  private readonly faderScales: number[] = Array(16).fill(127);
  private readonly send: Send;
  private readonly changed: () => void;
  private display: 'level' | 'pan' | null = null;
  private heldPotDisplay = false;
  private displayTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(send: Send, changed: () => void) {
    this.send = send;
    this.changed = changed;
  }

  reset(): void {
    this.levels.fill(null);
    this.baseLevels.fill(null);
    this.faderScales.fill(127);
    this.pans.fill(null);
    this.muted.fill(null);
    for (const group of this.groups) group.fill(null);
    this.group = 0;
    this.release();
  }

  leds(_scene: MixerScene, controller: ControllerState): Led[] {
    return this.muted.map((muted, index) => {
      if (controller.buttons[1]) return index === this.group ? groupSelected : index < this.groups.length ? groupOther : off;
      if (this.display) {
        const value = (this.display === 'level' ? this.levels : this.pans)[index];
        if (value === null) return off;
        if (this.display === 'pan') return mixerPanLed(value);
        return mixerLevelLed(value, muted === true);
      }
      if (muted === true) return off;
      return mixerScaleLed(this.faderScales[index]);
    });
  }

  handle(_scene: MixerScene, controller: ControllerState, event: SceneEvent): void {
    if (event.type === 'pad') {
      if (!this.heldPotDisplay || !controller.held.some(Boolean)) this.release();
      if (event.on && controller.buttons[0]) {
        const muted = this.muted[event.index] !== true;
        if (this.send('opz', [0xb0 + event.index, 53, muted ? 1 : 0])) this.setMute(event.index, muted);
        if (muted) {
          this.send('iac', [0xb0 + event.index, 120, 0]);
        }
      } else if (event.on && controller.buttons[1] && event.index < 10) {
        if (this.send('opz', [0xb0, 55, event.index])) this.selectGroup(event.index);
      }
    } else if (event.type === 'control') {
      const { control, value } = event;
      if (control !== IRIG_MIDI.cc.pot1 && control !== IRIG_MIDI.cc.pot2 && control !== IRIG_MIDI.cc.fader) return;
      if (control !== IRIG_MIDI.cc.fader) {
        this.display = control === IRIG_MIDI.cc.pot1 ? 'level' : 'pan';
        clearTimeout(this.displayTimer);
        this.displayTimer = undefined;
        this.heldPotDisplay = controller.held.some(Boolean);
        if (!this.heldPotDisplay) {
          this.displayTimer = setTimeout(() => {
            this.displayTimer = undefined;
            this.display = null;
            this.changed();
          }, displayTimeout);
        }
      }
      if (!controller.held.some(Boolean)) return;
      if (control === IRIG_MIDI.cc.fader && !this.heldPotDisplay) this.release();
      controller.held.forEach((held, index) => {
        if (!held) return;
        if (control === IRIG_MIDI.cc.pot2) {
          if (this.pans[index] !== value && this.send('opz', [0xb0 + index, 15, value])) {
            this.pans[index] = value;
            this.send('iac', [0xb0 + index, 15, value]);
          }
        } else if (control === IRIG_MIDI.cc.pot1) {
          if (this.baseLevels[index] !== value && this.send('opz', [0xb0 + index, 16, value])) {
            this.baseLevels[index] = value;
            this.levels[index] = this.scaledLevel(index, value);
            this.send('iac', [0xb0 + index, 16, this.levels[index]]);
          }
        } else {
          const base = this.baseLevels[index];
          if (base === null) return;
          if (this.faderScales[index] === value) return;
          const level = clamp(base * value / 127);
          if (this.send('iac', [0xb0 + index, 16, level])) {
            this.faderScales[index] = value;
            this.levels[index] = level;
          }
        }
      });
    }
  }

  receive(event: MidiEvent): void {
    if (event.type === 'program' || (event.type === 'control' && event.controller === 103)) {
      this.muted.fill(null);
      for (const group of this.groups) group.fill(null);
      this.group = 0;
      return;
    }
    if (event.type !== 'control') return;
    if (event.controller === 15) this.pans[event.channel] = event.value;
    else if (event.controller === 16) {
      this.baseLevels[event.channel] = event.value;
      this.levels[event.channel] = this.scaledLevel(event.channel, event.value);
    }
    else if (event.controller === 53 && event.value <= 1) this.setMute(event.channel, event.value === 1);
    else if (event.controller === 55 && event.value < 10) this.selectGroup(event.value);
  }

  scaledLevel(channel: number, value: number): number {
    return clamp(value * this.faderScales[channel] / 127);
  }

  guessMutes(muted: readonly boolean[]): void {
    muted.forEach((value, channel) => this.setMute(channel, value));
  }

  private setMute(channel: number, muted: boolean): void {
    this.muted[channel] = muted;
    this.groups[this.group][channel] = muted;
  }

  private selectGroup(group: number): void {
    this.group = group;
    this.muted.splice(0, 16, ...this.groups[group]);
  }

  release(): void {
    clearTimeout(this.displayTimer);
    this.displayTimer = undefined;
    this.display = null;
    this.heldPotDisplay = false;
  }
}
