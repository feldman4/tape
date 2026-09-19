// Project persistence — 10 fixed project slots ("project-01".."project-10")
// stored in IndexedDB, plus ZIP download/restore built on ./zipStore and
// ./projectCodec. Mirrors Tape's src/tape/session.ts DB-per-app pattern.

import { encodeProject, decodeProject } from './projectCodec';
import { createZip, readZip } from './zipStore';
import { makeDefaultProject, type Project } from './model';

const DB_NAME = 'loop-pad-projects';
const STORE_NAME = 'projects';
const DB_VERSION = 1;
export const PROJECT_COUNT = 10;

export function projectName(index: number): string {
  return `project-${String(index).padStart(2, '0')}`;
}

const PROJECT_NAME_PATTERN = /^project-(0[1-9]|10)$/;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'name' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

interface ProjectRecord {
  name: string;
  savedAt: number;
  bytes: Uint8Array;
}

async function putRecord(record: ProjectRecord): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function getRecord(name: string): Promise<ProjectRecord | undefined> {
  const db = await openDb();
  const record = await new Promise<ProjectRecord | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(name);
    req.onsuccess = () => resolve(req.result as ProjectRecord | undefined);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return record;
}

/** Removes all ten locally stored projects without changing device preferences. */
export async function clearAllProjects(): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function saveProject(index: number, project: Project): Promise<void> {
  await putRecord({ name: projectName(index), savedAt: Date.now(), bytes: encodeProject(project) });
}

export async function loadProject(index: number): Promise<Project> {
  const record = await getRecord(projectName(index));
  if (!record) return makeDefaultProject();
  return decodeProject(record.bytes);
}

/** Bundles all 10 projects (defaulting missing ones to empty) into one ZIP. */
export async function downloadAllProjects(): Promise<Blob> {
  const entries = [];
  for (let i = 1; i <= PROJECT_COUNT; i++) {
    const record = await getRecord(projectName(i));
    const bytes = record ? record.bytes : encodeProject(makeDefaultProject());
    entries.push({ name: projectName(i), data: bytes });
  }
  return createZip(entries);
}

/**
 * Restores projects from a ZIP: overwrites any of project-01..project-10
 * present as an exact top-level entry name; leaves missing ones unchanged;
 * ignores everything else.
 */
export async function restoreProjectsFromZip(data: ArrayBuffer): Promise<{ restored: string[] }> {
  const entries = await readZip(data);
  const restored: string[] = [];
  for (const entry of entries) {
    if (!PROJECT_NAME_PATTERN.test(entry.name)) continue;
    decodeProject(entry.data); // validates the payload before persisting
    await putRecord({ name: entry.name, savedAt: Date.now(), bytes: entry.data });
    restored.push(entry.name);
  }
  return { restored };
}

/** Restores a single project's contents from one project file, overwriting `index`. */
export async function restoreSingleProject(index: number, bytes: ArrayBuffer): Promise<void> {
  const data = new Uint8Array(bytes);
  decodeProject(data); // validates the payload before persisting
  await putRecord({ name: projectName(index), savedAt: Date.now(), bytes: data });
}
