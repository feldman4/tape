export type DrumPad = { channel: number; note: number; velocity: number };
export type MixerScene = { type: 'mixer'; pads: null[] };
export type EmptyScene = { type: 'empty'; pads: null[] };
export type DrumScene = { type: 'drum'; pads: (DrumPad | null)[] };
export type Scene = MixerScene | EmptyScene | DrumScene;
export type EditableSceneType = 'empty' | 'drum';
export type Project = { version: 1; scenes: Scene[] };

export function newScene(type: 'mixer'): MixerScene;
export function newScene(type: EditableSceneType): EmptyScene | DrumScene;
export function newScene(type: Scene['type']): Scene {
  const pads = Array<null>(16).fill(null);
  if (type === 'mixer') return { type, pads };
  if (type === 'drum') return { type, pads };
  return { type, pads };
}

export function newProject(): Project {
  return { version: 1, scenes: [newScene('mixer'), ...Array.from({ length: 15 }, () => newScene('empty'))] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function inRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

export function validateProject(project: unknown): project is Project {
  if (!isRecord(project) || project.version !== 1 || !Array.isArray(project.scenes) || project.scenes.length !== 16) return false;
  return project.scenes.every((item: unknown, index: number) => {
    if (!isRecord(item) || (index === 0 ? item.type !== 'mixer' : item.type !== 'empty' && item.type !== 'drum') ||
        !Array.isArray(item.pads) || item.pads.length !== 16) return false;
    return item.pads.every((pad: unknown) =>
      pad === null || (item.type === 'drum' && isRecord(pad) && inRange(pad.channel, 0, 3) &&
        inRange(pad.note, 0, 127) && inRange(pad.velocity, 0, 127)));
  });
}
