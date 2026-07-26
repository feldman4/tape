// Session persistence — saves/loads full tape sessions to IndexedDB.
// DB: "tape-sessions" (v1)
// Object store: "sessions" (key = session name string)
// Each record: SessionRecord

import type { Clip, Lane, Tape } from './model';
import { makeClip, LANE_COUNT } from './model';
import { AudioPool } from '../audio/audioPool';
import type { AudioBufferId } from '../audio/audioPool';

export interface SessionRecord {
  name: string;
  savedAt: number; // Date.now()
  version: 1;
  /** v1 legacy: lane 0 clips (absent in newer saves that use lanes[]). */
  clips?: Clip[];
  /** v2+: all lane clips. Index 0-3. */
  lanes?: Clip[][];
  tapeLength: number;
  loopIn: number;
  loopOut: number;
  loopEnabled: boolean;
  bpm?: number;
  playhead?: number;
  activeLane?: 0 | 1 | 2 | 3;
  laneMuted?: boolean[];
  laneGain?: number[];
  lanePan?: number[];
  mode?: 'free' | 'sync';
  snap?: boolean;
  audioBuffers: { id: AudioBufferId; buffer: ArrayBuffer }[];
}

const DB_NAME = 'tape-sessions';
const STORE_NAME = 'sessions';
const DB_VERSION = 1;

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

function rehydrateClips(raw: Clip[]): Clip[] {
  return raw.map((c) =>
    Object.assign(makeClip(c.id, c.audioBufferId, c.tapeStart, c.sourceStart, c.duration), {
      gain: c.gain ?? 1.0,
      muted: c.muted ?? false,
    }),
  );
}

export async function saveSession(name: string, tape: Tape, pool: AudioPool, mode: 'free' | 'sync' = 'sync', snap = true): Promise<void> {
  const allBuffers = pool.getAllBuffers();
  const allClips = tape.lanes.flatMap((l) => l.clips);
  const referencedIds = new Set(allClips.map((c) => c.audioBufferId));
  const audioBuffers: SessionRecord['audioBuffers'] = [];
  for (const [id, samples] of allBuffers) {
    if (!referencedIds.has(id)) continue;
    audioBuffers.push({ id, buffer: samples.buffer.slice(samples.byteOffset, samples.byteOffset + samples.byteLength) as ArrayBuffer });
  }

  const record: SessionRecord = {
    name,
    savedAt: Date.now(),
    version: 1,
    lanes: tape.lanes.map((l) => l.clips),
    tapeLength: tape.tapeLength,
    loopIn: tape.loopIn,
    loopOut: tape.loopOut,
    loopEnabled: tape.loopEnabled,
    bpm: tape.bpm,
    playhead: tape.playhead,
    activeLane: tape.activeLane,
    laneMuted: tape.lanes.map((l) => l.muted),
    laneGain:  tape.lanes.map((l) => l.gain),
    lanePan:   tape.lanes.map((l) => l.pan),
    mode,
    snap,
    audioBuffers,
  };

  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function loadSession(name: string): Promise<{ tape: Tape; pool: AudioPool; mode: 'free' | 'sync'; snap: boolean } | null> {
  const db = await openDb();
  const record = await new Promise<SessionRecord | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(name);
    req.onsuccess = () => resolve(req.result as SessionRecord | undefined);
    req.onerror = () => reject(req.error);
  });
  db.close();

  if (!record) return null;

  const pool = new AudioPool();
  for (const { id, buffer } of record.audioBuffers) {
    pool.restore(id, new Float32Array(buffer));
  }

  // Build 4 lanes — support both v2 (lanes[]) and v1 legacy (clips = lane 0).
  const rawLanes: Clip[][] = record.lanes
    ? record.lanes
    : [record.clips ?? [], [], [], []];

  const lanes = Array.from({ length: LANE_COUNT }, (_, i) =>
    ({
      clips: rehydrateClips(rawLanes[i] ?? []),
      muted: record.laneMuted?.[i] ?? false,
      gain:  record.laneGain?.[i]  ?? 1.0,
      pan:   record.lanePan?.[i]   ?? 0.0,
    }),
  ) as [Lane, Lane, Lane, Lane];

  const allClips = lanes.flatMap((l) => l.clips);
  const tapeLength = allClips.length === 0 ? 0 : Math.max(...allClips.map((c) => c.tapeStart + c.duration));

  const tape: Tape = {
    lanes,
    activeLane: (record.activeLane ?? 0) as 0 | 1 | 2 | 3,
    tapeLength,
    playhead: record.playhead ?? 0,
    loopIn: record.loopIn,
    loopOut: record.loopOut,
    loopEnabled: record.loopEnabled,
    bpm: record.bpm ?? 120,
  };

  return { tape, pool, mode: record.mode ?? 'sync', snap: record.snap ?? true };
}

export async function listSessions(): Promise<string[]> {
  const db = await openDb();
  const names = await new Promise<string[]>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).getAllKeys();
    req.onsuccess = () => resolve(req.result as string[]);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return names;
}

export async function deleteSession(name: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(name);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}
