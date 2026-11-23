import type { ControllerState } from './controller.ts';
import type { Control, IrigEvent, MidiEvent } from './midi.ts';
import type { DrumPad, DrumScene, Scene } from './model.ts';

export type Send = (destination: 'opz' | 'irig', bytes: number[]) => void;
export type Led = [red: number, green: number];

export type Transport = 'unknown' | 'running' | 'stopped';
export type SceneEvent =
  | (Exclude<IrigEvent, { type: 'scene' | 'control' }> & { time: number })
  | (Extract<IrigEvent, { type: 'control' }> & { delta: number; time: number })
  | { type: 'midi'; event: MidiEvent; transport: Transport; time: number };

export interface SceneHandler<S extends Scene> {
  leds(scene: S, controller: ControllerState): Led[];
  handle(scene: S, controller: ControllerState, event: SceneEvent): void;
  release(): void;
}

const colors: Led[] = [[127, 100], [127, 0], [127, 35], [0, 127]];

export class DrumHandler implements SceneHandler<DrumScene> {
  private readonly playing = new Map<number, DrumPad>();
  private readonly auditions = new Map<number, { interval: ReturnType<typeof setInterval>; timeout: ReturnType<typeof setTimeout> }>();

  constructor(privateSend: Send, privateSave: () => void) {
    this.send = privateSend;
    this.save = privateSave;
  }
  private readonly send: Send;
  private readonly save: () => void;

  leds(scene: DrumScene, controller: ControllerState): Led[] {
    return scene.pads.map((pad, index) => {
      if (!pad) return [0, 0];
      const factor = controller.held[index] ? 1 : 0.45;
      const [red, green] = colors[pad.channel];
      return [Math.round(red * factor), Math.round(green * factor)];
    });
  }

  handle(scene: DrumScene, controller: ControllerState, event: SceneEvent): void {
    switch (event.type) {
      case 'pad':
        this.pad(scene, event.index, event.on, event.velocity);
        break;
      case 'control':
        if (event.delta || (event.control === 1 && !controller.buttons[0] && !controller.buttons[1])) {
          this.control(scene, controller, event.control, event.delta, event.value);
        }
        break;
      case 'midi':
        this.midi(scene, controller, event.event, event.transport);
        break;
    }
  }

  private pad(scene: DrumScene, index: number, on: boolean, velocity: number): void {
    const pad = scene.pads[index];
    if (on && pad) {
      this.send('opz', [0x90 + pad.channel, pad.note, Math.max(1, Math.round(velocity * pad.velocity / 127))]);
      this.playing.set(index, { ...pad });
    } else if (!on) {
      this.clearAudition(index);
      this.stopNote(index);
    }
  }

  private control(scene: DrumScene, controller: ControllerState, control: Control, delta: number, value: number): void {
    const modifier = controller.buttons[0] ? 1 : controller.buttons[1] ? 2 : 0;
    const table: Partial<Record<Control, number>>[] = [
      { 10: 1, 11: 2, 7: controller.push ? 4 : 3 },
      { 10: 5, 11: 6, 7: controller.push ? 8 : 7, 1: 9 },
      { 10: 13, 11: 14, 7: controller.push ? 16 : 15, 1: 9 },
    ];
    let dirty = false;
    const adjustedChannels = new Set<number>();
    controller.held.forEach((held, index) => {
      const pad = scene.pads[index];
      if (!held || !pad) return;
      if (control === 1 && modifier === 0) {
        pad.velocity = value;
        dirty = true;
        return;
      }
      const cc = table[modifier][control];
      if (!cc) return;
      if (!adjustedChannels.has(pad.channel)) {
        for (let i = 0; i < Math.min(Math.abs(delta), 127); i++) {
          this.send('opz', [0xb0 + pad.channel, cc + 31, delta > 0 ? 1 : 127]);
        }
        adjustedChannels.add(pad.channel);
      }
      this.audition(index, pad);
    });
    if (dirty) this.save();
  }

  private midi(scene: DrumScene, controller: ControllerState, event: MidiEvent, transport: Transport): void {
    if (event.type !== 'note' || !event.on || event.channel >= 4 || transport !== 'stopped') return;
    let dirty = false;
    controller.held.forEach((held, index) => {
      if (!held) return;
      this.stopAudition(index);
      this.stopNote(index);
      scene.pads[index] = { channel: event.channel, note: Math.max(0, Math.min(127, event.note)), velocity: 127 };
      dirty = true;
    });
    if (dirty) this.save();
  }

  release(): void {
    for (const index of this.playing.keys()) this.stopNote(index);
    for (const index of this.auditions.keys()) this.clearAudition(index);
  }

  private stopNote(index: number): void {
    const pad = this.playing.get(index);
    if (!pad) return;
    this.send('opz', [0x80 + pad.channel, pad.note, 0]);
    this.playing.delete(index);
  }

  private clearAudition(index: number): void {
    const audition = this.auditions.get(index);
    if (!audition) return;
    clearInterval(audition.interval);
    clearTimeout(audition.timeout);
    this.auditions.delete(index);
  }

  private stopAudition(index: number): void {
    if (!this.auditions.has(index)) return;
    this.clearAudition(index);
    this.stopNote(index);
  }

  private audition(index: number, pad: DrumPad): void {
    const previous = this.auditions.get(index);
    if (previous) {
      clearTimeout(previous.timeout);
      previous.timeout = setTimeout(() => this.stopAudition(index), 200);
      return;
    }
    const repeat = () => {
      this.send('opz', [0x80 + pad.channel, pad.note, 0]);
      this.send('opz', [0x90 + pad.channel, pad.note, Math.max(1, pad.velocity)]);
      this.playing.set(index, { ...pad });
    };
    repeat();
    this.auditions.set(index, {
      interval: setInterval(repeat, 120),
      timeout: setTimeout(() => this.stopAudition(index), 200),
    });
  }
}

export class InactiveHandler implements SceneHandler<Scene> {
  leds(scene: Scene): Led[] { return scene.pads.map(() => [0, 0]); }
  handle(): void {}
  release(): void {}
}
