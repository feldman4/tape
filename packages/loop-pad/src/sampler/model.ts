// 16-slot sampler data model. A Slot holds at most one recorded sample plus
// its per-slot mixer settings; a Project is the 16 slots persisted together.

export const SLOT_COUNT = 16;
export const BANK_COUNT = 2;
export type BankIndex = 0 | 1;

export type RecordingMode = 'one-shot' | 'take';

export type SlotActivity =
  | { kind: 'idle' }
  | { kind: 'recording'; mode: RecordingMode; startedEmpty: boolean }
  | { kind: 'playing' };

export type SlotDisplayState = 'empty' | 'recording' | 'stopped' | 'playing';
export type SampleTakeStatus = 'finalized' | 'unfinalized';

export interface SlotMixer {
  level: number;      // 0..1
  pan: number;        // -1 (full left) .. 0 .. +1 (full right)
  lpfCutoff: number;  // 0..1, 1 = fully open (no attenuation)
  hpfCutoff: number;  // 0..1, 0 = fully open (no attenuation)
}

export interface StereoSamples {
  left: Float32Array;
  right: Float32Array;
}

export interface StoredSample {
  samples: StereoSamples;
  sampleRate: number;
  peaks: number[];
  takeStatus: SampleTakeStatus;
}

export interface Slot {
  activity: SlotActivity;
  sample: StoredSample | null;
  /** Live peak envelope accumulated while recording, for the recording-state ring. */
  recordingPeaks: number[];
  mixer: SlotMixer;
}

export interface Project {
  banks: [Slot[], Slot[]];
}

export function makeDefaultMixer(): SlotMixer {
  return { level: 1, pan: 0, lpfCutoff: 1, hpfCutoff: 0 };
}

export function makeDefaultSlot(): Slot {
  return {
    activity: { kind: 'idle' },
    sample: null,
    recordingPeaks: [],
    mixer: makeDefaultMixer(),
  };
}

export function getSlotDisplayState(slot: Slot): SlotDisplayState {
  if (slot.activity.kind === 'recording') return 'recording';
  if (slot.activity.kind === 'playing') return 'playing';
  return slot.sample ? 'stopped' : 'empty';
}

export function makeDefaultProject(): Project {
  return {
    banks: [
      Array.from({ length: SLOT_COUNT }, () => makeDefaultSlot()),
      Array.from({ length: SLOT_COUNT }, () => makeDefaultSlot()),
    ],
  };
}

const PEAK_BUCKETS = 96;

/** Downsamples a recorded buffer into a fixed-size peak envelope for display. */
export function computePeaks(samples: StereoSamples, buckets = PEAK_BUCKETS): number[] {
  if (samples.left.length === 0) return [];
  const bucketSize = Math.max(1, Math.floor(samples.left.length / buckets));
  const peaks: number[] = [];
  for (let start = 0; start < samples.left.length; start += bucketSize) {
    let peak = 0;
    const end = Math.min(start + bucketSize, samples.left.length);
    for (let i = start; i < end; i++) {
      peak = Math.max(peak, Math.abs(samples.left[i]!), Math.abs(samples.right[i]!));
    }
    peaks.push(peak);
  }
  return peaks;
}
