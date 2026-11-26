import { validateCustomSlots, validateDrumScene, validateProject } from './model.ts';
import type { CustomSlot, DrumScene, Project } from './model.ts';

type Named<T> = { name: string; value: T };
export type Library = { version: 2; projects: Named<Project>[]; kits: Named<DrumScene>[] };

const projectKey = 'opz-pads-project-v1';
const libraryKey = 'opz-pads-library-v1';
const slotsKey = 'opz-pads-fx-slots-v1';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function validEntries<T>(value: unknown, validate: (item: unknown) => item is T): value is Named<T>[] {
  if (!Array.isArray(value)) return false;
  const names = new Set<string>();
  return value.every((entry: unknown) => {
    if (!isRecord(entry) || typeof entry.name !== 'string' || !entry.name.trim() ||
      entry.name !== entry.name.trim() || names.has(entry.name) || !validate(entry.value)) return false;
    names.add(entry.name);
    return true;
  });
}

export function loadProject(): Project | null {
  const saved = localStorage.getItem(projectKey);
  if (!saved) return null;
  const project: unknown = JSON.parse(saved);
  if (!validateProject(project)) throw new Error('Stored project has an invalid or unsupported format');
  return project;
}

export function saveProject(project: Project): void {
  localStorage.setItem(projectKey, JSON.stringify(project));
}

export function loadCustomSlots(): CustomSlot[] | null {
  const saved = localStorage.getItem(slotsKey);
  if (!saved) return null;
  const data: unknown = JSON.parse(saved);
  if (!isRecord(data) || data.version !== 1 || !('slots' in data)) {
    throw new Error('Stored custom slots have an invalid or unsupported format');
  }
  if (!validateCustomSlots(data.slots)) throw new Error('Invalid custom performance FX slots');
  return data.slots;
}

export function saveCustomSlots(slots: CustomSlot[]): void {
  if (!validateCustomSlots(slots)) throw new Error('Enter valid MIDI values.');
  localStorage.setItem(slotsKey, JSON.stringify({ version: 1, slots }));
}

export function loadLibrary(): Library {
  const saved = localStorage.getItem(libraryKey);
  const value: unknown = saved === null ? { version: 2, projects: [], kits: [] } : JSON.parse(saved);
  if (!isRecord(value) || value.version !== 2 ||
    !validEntries(value.projects, validateProject) || !validEntries(value.kits, validateDrumScene)) {
    localStorage.removeItem(libraryKey);
    console.warn('Reset invalid or unsupported stored library.');
    return { version: 2, projects: [], kits: [] };
  }
  return { version: 2, projects: value.projects, kits: value.kits };
}

export function saveLibrary(library: Library): void {
  localStorage.setItem(libraryKey, JSON.stringify(library));
}

export function parseProjectFile(value: unknown): Project {
  if (!validateProject(value)) throw new Error('Invalid or unsupported project file');
  return value;
}

export function parseKitFile(value: unknown): DrumScene {
  if (!isRecord(value) || value.version !== 2 || !validateDrumScene(value.kit)) {
    throw new Error('Invalid or unsupported kit file');
  }
  return value.kit;
}

export function filename(type: 'project' | 'kit', name: string): string {
  const safeName = Array.from(name, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || '%<>:"/\\|?*'.includes(character)
      ? `%${code.toString(16).toUpperCase().padStart(2, '0')}` : character;
  }).join('');
  return `${type}_${safeName}.json`;
}

export function nameFromFile(type: 'project' | 'kit', filename: string): string {
  const stem = filename.replace(/\.json$/i, '');
  const prefix = `${type}_`;
  const name = (stem.startsWith(prefix) ? decodeURIComponent(stem.slice(prefix.length)) : stem).trim();
  if (!name) throw new Error('The filename must contain a name.');
  return name;
}
