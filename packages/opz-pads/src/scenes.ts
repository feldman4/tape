import type { ControllerState } from './controller.ts';
import type { Control, IrigEvent, MidiEvent } from './midi.ts';
import type { DrumPad, DrumScene, Scene } from './model.ts';
import { isDrumChannel } from './model.ts';
import { IRIG_MIDI } from './irig-midi.ts';
import { drumLed, off } from './irig-colors.ts';
import type { Led } from './irig-colors.ts';

export type Send = (destination: 'opz' | 'irig' | 'iac', bytes: number[]) => boolean;
export type { Led } from './irig-colors.ts';

export type Transport = 'unknown' | 'running' | 'stopped';
export type SceneEvent =
  | (Exclude<IrigEvent, { type: 'control' }> & { time: number })
  | (Extract<IrigEvent, { type: 'control' }> & { delta: number; time: number })
  | { type: 'midi'; event: MidiEvent; transport: Transport; time: number };

export interface SceneHandler<S extends Scene> {
  leds(scene: S, controller: ControllerState): Led[];
  handle(scene: S, controller: ControllerState, event: SceneEvent): void;
  release(): void;
}

const velocityDisplayDuration = 250;

export class DrumHandler implements SceneHandler<DrumScene> {
  private readonly playing = new Map<number, DrumPad>();
  private readonly auditions = new Map<number, { interval: ReturnType<typeof setInterval>; timeout: ReturnType<typeof setTimeout> }>();
  private readonly velocityTimers = new Map<number, ReturnType<typeof setTimeout>>();
  readonly velocities = Array<number | null>(16).fill(null);

  constructor(
    privateSend: Send,
    privateSave: () => void,
    parameterValue: (channel: number, cc: number) => number | null,
    sendParameter: (channel: number, cc: number, value: number) => void,
    changed: () => void,
  ) {
    this.send = privateSend;
    this.save = privateSave;
    this.parameterValue = parameterValue;
    this.sendParameter = sendParameter;
    this.changed = changed;
  }
  private readonly send: Send;
  private readonly save: () => void;
  private readonly parameterValue: (channel: number, cc: number) => number | null;
  private readonly sendParameter: (channel: number, cc: number, value: number) => void;
  private readonly changed: () => void;

  leds(scene: DrumScene, controller: ControllerState): Led[] {
    return scene.pads.map((pad, index) => {
      if (!pad) return off;
      return drumLed(pad.channel, controller.held[index]);
    });
  }

  handle(scene: DrumScene, controller: ControllerState, event: SceneEvent): void {
    switch (event.type) {
      case 'pad':
        this.pad(scene, event.index, event.on, event.velocity);
        break;
      case 'control':
        if (event.control !== IRIG_MIDI.cc.data || event.delta) {
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
      const playedVelocity = Math.max(1, Math.round(velocity * pad.velocity / 127));
      this.sendNote([0x90 + pad.channel, pad.note, playedVelocity]);
      this.playing.set(index, { ...pad });
      this.showVelocity(index, playedVelocity);
    } else if (!on) {
      this.clearAudition(index);
      this.stopNote(index);
    }
  }

  private control(scene: DrumScene, controller: ControllerState, control: Control, delta: number, value: number): void {
    const modifier = controller.buttons[0] ? 1 : controller.buttons[1] ? 2 : 0;
    const table: Partial<Record<Control, number>>[] = [
      { [IRIG_MIDI.cc.pot1]: 1, [IRIG_MIDI.cc.pot2]: 2, [IRIG_MIDI.cc.data]: controller.push ? 4 : 3 },
      { [IRIG_MIDI.cc.pot1]: 5, [IRIG_MIDI.cc.pot2]: 6, [IRIG_MIDI.cc.data]: controller.push ? 8 : 7, [IRIG_MIDI.cc.fader]: 9 },
      { [IRIG_MIDI.cc.pot1]: 13, [IRIG_MIDI.cc.pot2]: 14, [IRIG_MIDI.cc.data]: controller.push ? 16 : 15, [IRIG_MIDI.cc.fader]: 9 },
    ];
    let dirty = false;
    const adjustedChannels = new Set<number>();
    controller.held.forEach((held, index) => {
      const pad = scene.pads[index];
      if (!held || !pad) return;
      if (control === IRIG_MIDI.cc.fader && modifier === 0) {
        pad.velocity = value;
        dirty = true;
        return;
      }
      const cc = table[modifier][control];
      if (!cc) return;
      if (!adjustedChannels.has(pad.channel)) {
        const next = control === IRIG_MIDI.cc.data
          ? Math.max(0, Math.min(127, (this.parameterValue(pad.channel, cc) ?? 64) + delta))
          : value;
        this.sendParameter(pad.channel, cc, next);
        adjustedChannels.add(pad.channel);
      }
      this.audition(index, pad);
    });
    if (dirty) this.save();
  }

  private midi(scene: DrumScene, controller: ControllerState, event: MidiEvent, transport: Transport): void {
    if (event.type !== 'note' || !event.on || !isDrumChannel(event.channel) || transport !== 'stopped') return;
    const channel = event.channel;
    let dirty = false;
    const note = Math.max(0, Math.min(127, event.note));
    controller.held.forEach((held, index) => {
      if (!held) return;
      const pad = scene.pads[index];
      if (pad && pad.channel === channel && pad.note === note) return;
      this.stopAudition(index);
      this.stopNote(index);
      this.clearVelocity(index);
      scene.pads[index] = { channel, note, velocity: pad?.velocity ?? 127 };
      dirty = true;
    });
    if (dirty) this.save();
  }

  release(): void {
    for (const index of this.playing.keys()) this.stopNote(index);
    for (const index of this.auditions.keys()) this.clearAudition(index);
    for (const index of this.velocityTimers.keys()) this.clearVelocity(index);
    this.velocities.fill(null);
  }

  private stopNote(index: number): void {
    const pad = this.playing.get(index);
    if (!pad) return;
    this.sendNote([0x80 + pad.channel, pad.note, 0]);
    this.playing.delete(index);
    if (!this.velocityTimers.has(index)) this.velocities[index] = null;
  }

  private showVelocity(index: number, velocity: number): void {
    clearTimeout(this.velocityTimers.get(index));
    this.velocities[index] = velocity;
    this.velocityTimers.set(index, setTimeout(() => {
      this.velocityTimers.delete(index);
      if (!this.playing.has(index)) {
        this.velocities[index] = null;
        this.changed();
      }
    }, velocityDisplayDuration));
  }

  private clearVelocity(index: number): void {
    clearTimeout(this.velocityTimers.get(index));
    this.velocityTimers.delete(index);
    this.velocities[index] = null;
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
      previous.timeout = setTimeout(() => { this.stopAudition(index); this.changed(); }, 200);
      return;
    }
    const repeat = () => {
      this.sendNote([0x80 + pad.channel, pad.note, 0]);
      this.sendNote([0x90 + pad.channel, pad.note, Math.max(1, pad.velocity)]);
      this.playing.set(index, { ...pad });
      this.showVelocity(index, Math.max(1, pad.velocity));
    };
    repeat();
    this.auditions.set(index, {
      interval: setInterval(() => {
        const previousVelocity = this.velocities[index];
        repeat();
        if (this.velocities[index] !== previousVelocity) this.changed();
      }, 120),
      timeout: setTimeout(() => { this.stopAudition(index); this.changed(); }, 200),
    });
  }

  private sendNote(bytes: number[]): void {
    this.send('opz', bytes);
    if ((bytes[0] & 0x0f) !== 12) this.send('iac', bytes);
  }
}

export class InactiveHandler implements SceneHandler<Scene> {
  leds(scene: Scene): Led[] { return scene.pads.map(() => off); }
  handle(): void {}
  release(): void {}
}
