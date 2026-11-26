export type DrumChannel = 0 | 1 | 2 | 3 | 12;
export type DrumPad = { channel: DrumChannel; note: number; velocity: number };
export type MixerScene = { type: 'mixer'; pads: null[] };
export type EmptyScene = { type: 'empty'; pads: null[] };
export type DrumScene = { type: 'drum'; pads: (DrumPad | null)[] };
export type FxOffset = { channel: number; cc: number; offset: number };
export type FxPad = { type: 'note'; channel: number; note: number } |
  { type: 'scene'; offsets: FxOffset[] } | { type: 'custom'; slot: number };
export type FxScene = { type: 'fx'; pads: (FxPad | null)[]; a: number | null; b: number | null };
export type CustomSlot = { channel: number; cc: number; min: number; max: number };
export type Scene = MixerScene | EmptyScene | DrumScene | FxScene;
export type EditableSceneType = 'empty' | 'drum' | 'fx';
export type Project = { version: 2; scenes: Scene[] };

export function newScene(type: 'mixer'): MixerScene;
export function newScene(type: 'drum'): DrumScene;
export function newScene(type: 'empty'): EmptyScene;
export function newScene(type: 'fx'): FxScene;
export function newScene(type: EditableSceneType): EmptyScene | DrumScene | FxScene;
export function newScene(type: Scene['type']): Scene {
  const pads = Array<null>(16).fill(null);
  if (type === 'mixer') return { type, pads };
  if (type === 'drum') return { type, pads };
  if (type === 'fx') return { type, pads, a: null, b: null };
  return { type, pads };
}

export function newProject(): Project {
  return { version: 2, scenes: [newScene('mixer'), ...Array.from({ length: 15 }, () => newScene('empty'))] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function inRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

export function isDrumChannel(value: unknown): value is DrumChannel {
  return inRange(value, 0, 3) || value === 12;
}

export function validateDrumScene(scene: unknown): scene is DrumScene {
  return isRecord(scene) && scene.type === 'drum' && Array.isArray(scene.pads) && scene.pads.length === 16 &&
    scene.pads.every((pad: unknown) => pad === null || (isRecord(pad) && isDrumChannel(pad.channel) &&
      inRange(pad.note, 0, 127) && inRange(pad.velocity, 0, 127)));
}

export function validateCustomSlots(value: unknown): value is CustomSlot[] {
  return Array.isArray(value) && value.length === 16 && value.every((slot: unknown) =>
    isRecord(slot) && inRange(slot.channel, 0, 15) && inRange(slot.cc, 0, 127) &&
    inRange(slot.min, 0, 127) && inRange(slot.max, 0, 127));
}

function validateFxScene(scene: Record<string, unknown>): boolean {
  if (!Array.isArray(scene.pads) || scene.pads.length !== 16) return false;
  const pads: unknown[] = scene.pads;
  const valid = pads.every((pad: unknown) => {
    if (pad === null) return true;
    if (!isRecord(pad)) return false;
    if (pad.type === 'note') return inRange(pad.channel, 0, 15) && inRange(pad.note, 0, 127);
    if (pad.type === 'custom') return inRange(pad.slot, 0, 15);
    if (pad.type !== 'scene' || !Array.isArray(pad.offsets)) return false;
    const keys = new Set<string>();
    return pad.offsets.every((offset: unknown) => {
      if (!isRecord(offset) || !inRange(offset.channel, 0, 15) || !inRange(offset.cc, 1, 16) ||
        !inRange(offset.offset, -127, 127)) return false;
      const key = `${offset.channel}:${offset.cc}`;
      if (keys.has(key)) return false;
      keys.add(key);
      return true;
    });
  });
  return valid && [scene.a, scene.b].every((index) => {
    if (index === null) return true;
    if (!inRange(index, 0, 15)) return false;
    const pad = pads[index];
    return isRecord(pad) && pad.type === 'scene';
  });
}

export function validateProject(project: unknown): project is Project {
  if (!isRecord(project) || project.version !== 2 || !Array.isArray(project.scenes) || project.scenes.length !== 16) return false;
  return project.scenes.every((item: unknown, index: number) => {
    if (!isRecord(item) || (index === 0 ? item.type !== 'mixer' : item.type !== 'empty' && item.type !== 'drum' && item.type !== 'fx') ||
        !Array.isArray(item.pads) || item.pads.length !== 16) return false;
    if (item.type === 'fx') return validateFxScene(item);
    return item.type === 'drum' ? validateDrumScene(item) : item.pads.every((pad: unknown) => pad === null);
  });
}
