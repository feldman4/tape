import type { ControllerState } from './controller.ts';
import { IRIG_MIDI } from '../irig/midi.ts';
import type { CustomSlot, FxOffset, FxPad, FxScene } from '../project/model.ts';
import type { Led, SceneEvent, SceneHandler, Send } from './scenes.ts';
import { fxLed, off } from '../irig/colors.ts';

const clamp = (value: number): number => Math.max(0, Math.min(127, Math.round(value)));
const key = (channel: number, cc: number): string => `${channel}:${cc}`;
const assignmentMotion = 15;

export class PerformanceFxHandler implements SceneHandler<FxScene> {
  private readonly held: number[] = [];
  private readonly playing = new Map<number, Extract<FxPad, { type: 'note' }>>();
  private readonly gestures = new Map<string, { value: number; direction: number; time: number }>();
  private readonly applied = new Set<string>();
  private editing: { pad: number; channel: number; cc: number } | null = null;
  private scene: FxScene | null = null;
  private controller: ControllerState | null = null;
  private pot2Start: number | null = null;
  private pot2Last: number | null = null;
  private pot2Direction = 0;
  private readonly send: Send;
  private readonly save: () => void;
  private readonly slots: () => CustomSlot[];
  private readonly apply: (channel: number, cc: number, value: { type: 'custom' | 'offset'; value: number } | null) => void;

  constructor(
    send: Send,
    save: () => void,
    slots: () => CustomSlot[],
    apply: (channel: number, cc: number, value: { type: 'custom' | 'offset'; value: number } | null) => void,
  ) {
    this.send = send;
    this.save = save;
    this.slots = slots;
    this.apply = apply;
  }

  activate(scene: FxScene, controller: ControllerState): void {
    this.scene = scene;
    this.controller = controller;
    this.resetPot2(controller.pots[1]);
    this.recalculate();
  }

  leds(scene: FxScene, controller: ControllerState): Led[] {
    return scene.pads.map((pad, index) => {
      if (!pad) return off;
      let depth = controller.held[index] ? controller.pressure[index] / 127 : 0;
      if (pad.type === 'scene') {
        if (scene.a === index) depth = Math.max(depth, 1 - controller.fader / 127);
        if (scene.b === index) depth = Math.max(depth, controller.fader / 127);
      }
      return fxLed(pad.type, depth);
    });
  }

  handle(scene: FxScene, controller: ControllerState, event: SceneEvent): void {
    this.scene = scene;
    this.controller = controller;
    if (event.type === 'pad') {
      this.resetPot2(controller.pots[1]);
      if (event.on) {
        this.held.push(event.index);
        this.gestures.clear();
        const pad = scene.pads[event.index];
        if (pad?.type === 'note') {
          this.sendNote(pad, true, event.velocity);
          this.playing.set(event.index, { ...pad });
        }
      } else {
        const index = this.held.indexOf(event.index);
        if (index >= 0) this.held.splice(index, 1);
        this.stopNote(event.index);
        if (this.editing?.pad === event.index) this.editing = null;
        this.gestures.clear();
      }
      this.recalculate();
    } else if (event.type === 'pressure') {
      this.recalculate();
    } else if (event.type === 'push' && event.pressed && this.editing) {
      this.editing = null;
      this.recalculate();
    } else if (event.type === 'control') {
      this.control(scene, controller, event);
    } else if (event.type === 'midi') {
      this.midi(scene, event);
    }
  }

  private control(scene: FxScene, controller: ControllerState, event: Extract<SceneEvent, { type: 'control' }>): void {
    const index = this.held.at(-1);
    if (event.control === IRIG_MIDI.cc.pot2) {
      if (this.pot2Last === null || this.pot2Start === null) {
        this.resetPot2(event.value);
        return;
      }
      const direction = Math.sign(event.value - this.pot2Last);
      if (!direction) return;
      if (this.pot2Direction && direction !== this.pot2Direction) this.pot2Start = this.pot2Last;
      this.pot2Direction = direction;
      this.pot2Last = event.value;
      if (Math.abs(event.value - this.pot2Start) < assignmentMotion) return;
      this.resetPot2(event.value);
      const side = direction < 0 ? 'a' : 'b';
      if (index === undefined) scene[side] = null;
      else if (scene.pads[index]?.type === 'scene') scene[side] = index;
      else return;
      this.save();
      this.recalculate();
    } else if (event.control === IRIG_MIDI.cc.data && event.delta && index !== undefined) {
      if (controller.push) {
        this.stopNote(index);
        const pad = scene.pads[index];
        const slot = pad?.type === 'custom' ? (pad.slot + event.delta % 16 + 16) % 16 : (event.delta > 0 ? 0 : 15);
        scene.pads[index] = { type: 'custom', slot };
        if (scene.a === index) scene.a = null;
        if (scene.b === index) scene.b = null;
        this.editing = null;
      } else if (this.editing?.pad === index) {
        const pad = scene.pads[index];
        if (pad?.type !== 'scene') return;
        const offset = pad.offsets.find((item) => item.channel === this.editing?.channel && item.cc === this.editing.cc);
        if (!offset) return;
        offset.offset = Math.max(-127, Math.min(127, offset.offset + event.delta));
      } else return;
      this.save();
      this.recalculate();
    } else if (event.control === IRIG_MIDI.cc.fader) this.recalculate();
  }

  private resetPot2(value: number | null): void {
    this.pot2Start = value;
    this.pot2Last = value;
    this.pot2Direction = 0;
  }

  private midi(scene: FxScene, { event, transport, time }: Extract<SceneEvent, { type: 'midi' }>): void {
    const index = this.held.at(-1);
    if (index === undefined) return;
    if (event.type === 'note' && event.on && transport === 'stopped') {
      this.stopNote(index);
      scene.pads[index] = { type: 'note', channel: event.channel, note: event.note };
      if (scene.a === index) scene.a = null;
      if (scene.b === index) scene.b = null;
      this.editing = null;
      this.save();
      this.recalculate();
    } else if (event.type === 'control' && event.controller >= 1 && event.controller <= 16) {
      const id = key(event.channel, event.controller);
      const previous = this.gestures.get(id);
      const direction = previous ? Math.sign(event.value - previous.value) : 0;
      if (previous && direction && previous.direction && direction !== previous.direction && time - previous.time <= 500) {
        this.stopNote(index);
        let pad = scene.pads[index];
        if (pad?.type !== 'scene') {
          pad = { type: 'scene', offsets: [] };
          scene.pads[index] = pad;
        }
        const existing = pad.offsets.findIndex((offset) => offset.channel === event.channel && offset.cc === event.controller);
        if (existing >= 0) {
          pad.offsets.splice(existing, 1);
          this.editing = null;
        } else {
          pad.offsets.push({ channel: event.channel, cc: event.controller, offset: 0 });
          this.editing = { pad: index, channel: event.channel, cc: event.controller };
        }
        this.gestures.delete(id);
        this.save();
        this.recalculate();
      } else {
        this.gestures.set(id, { value: event.value, direction, time });
      }
    }
  }

  private stopNote(index: number): void {
    const pad = this.playing.get(index);
    if (!pad) return;
    this.sendNote(pad, false, 0);
    this.playing.delete(index);
  }

  private sendNote(pad: Extract<FxPad, { type: 'note' }>, on: boolean, velocity: number): void {
    const bytes = [(on ? 0x90 : 0x80) + pad.channel, pad.note, velocity];
    this.send('opz', bytes);
    if (pad.channel !== 12) this.send('iac', bytes);
  }

  private blend(scene: FxScene, controller: ControllerState): { active: number | undefined; pressure: number; a: number; b: number } {
    const active = [...this.held].reverse().find((index) => scene.pads[index]?.type === 'scene');
    const pressure = active === undefined ? 0 : this.editing?.pad === active ? 1 : controller.pressure[active] / 127;
    return { active, pressure, a: (1 - controller.fader / 127) * (1 - pressure), b: controller.fader / 127 * (1 - pressure) };
  }

  depths(scene: FxScene, controller: ControllerState): number[] {
    const depths = Array<number>(16).fill(0);
    const { active, pressure, a, b } = this.blend(scene, controller);
    if (scene.a !== null) depths[scene.a] += a;
    if (scene.b !== null) depths[scene.b] += b;
    if (active !== undefined) depths[active] += pressure;
    scene.pads.forEach((pad, index) => {
      if (pad?.type === 'custom' && controller.held[index]) depths[index] = controller.pressure[index] / 127;
      else depths[index] = Math.min(1, depths[index]);
    });
    return depths;
  }

  private offsets(): Map<string, number> {
    const result = new Map<string, number>();
    if (!this.scene || !this.controller) return result;
    const { scene, controller } = this;
    const add = (offsets: FxOffset[], weight: number) => {
      for (const offset of offsets) {
        const id = key(offset.channel, offset.cc);
        result.set(id, (result.get(id) ?? 0) + offset.offset * weight);
      }
    };
    const { active, pressure, a: aDepth, b: bDepth } = this.blend(scene, controller);
    const a = scene.a === null ? null : scene.pads[scene.a];
    const b = scene.b === null ? null : scene.pads[scene.b];
    if (a?.type === 'scene') add(a.offsets, aDepth);
    if (b?.type === 'scene') add(b.offsets, bDepth);
    const pad = active === undefined ? null : scene.pads[active];
    if (pad?.type === 'scene') add(pad.offsets, pressure);
    return result;
  }

  value(channel: number, cc: number, base: number): number {
    const offset = this.offsets().get(key(channel, cc)) ?? 0;
    const custom = this.customValues().get(key(channel, cc));
    return custom ?? clamp(base + offset);
  }

  private customValues(): Map<string, number> {
    const result = new Map<string, number>();
    if (!this.scene || !this.controller) return result;
    for (const index of this.held) {
      const pad = this.scene.pads[index];
      if (pad?.type !== 'custom') continue;
      const slot = this.slots()[pad.slot];
      result.set(key(slot.channel, slot.cc), clamp(slot.min + (slot.max - slot.min) * this.controller.pressure[index] / 127));
    }
    return result;
  }

  recalculate(): void {
    const offsets = this.offsets();
    const custom = this.customValues();
    const current = new Set([...offsets.keys(), ...custom.keys()]);
    for (const id of new Set([...this.applied, ...current])) {
      const [channel, cc] = id.split(':').map(Number);
      const customValue = custom.get(id);
      const offset = offsets.get(id);
      this.apply(channel, cc, customValue !== undefined ? { type: 'custom', value: customValue } :
        offset !== undefined ? { type: 'offset', value: offset } : null);
    }
    this.applied.clear();
    for (const id of current) this.applied.add(id);
  }

  release(): void {
    for (const index of this.playing.keys()) this.stopNote(index);
    this.held.length = 0;
    this.editing = null;
    this.gestures.clear();
    this.resetPot2(null);
    this.scene = null;
    this.controller = null;
    this.recalculate();
  }
}
