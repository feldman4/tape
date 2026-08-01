import type { TapeAction } from './tapeActions';

export type ReelSector = 'playhead' | 'loop';

export interface ReelIntent {
  sector: ReelSector;
  delta: number;
  shift: boolean;
}

/**
 * Converts the iPad reel's device-neutral movement into the existing semantic
 * tape command. Timing units and snap policy remain the dispatcher's concern.
 */
export function reelIntentToAction({ sector, delta, shift }: ReelIntent): TapeAction {
  if (sector === 'playhead') {
    return { type: 'encoderNudge', index: 0, delta, shift };
  }
  return { type: 'encoderNudge', index: shift ? 2 : 1, delta, shift: false };
}