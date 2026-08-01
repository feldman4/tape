// Shared mutable-ref bundle and types used across TapePage hooks and tabs.
import type { MutableRefObject } from 'react';
import type { AudioEngine } from '../audio/audioEngine';
import type { AudioPool } from '../audio/audioPool';
import type { SyncEngine } from '../sync/syncEngine';
import type { OpzControlMode, ControlEvent } from '../sync/opzControlMode';
import type { Clip, Tape, Lane } from '../tape/model';

export type Mode = 'free' | 'sync';
export type TransportState = 'idle' | 'armed' | 'counting-in' | 'recording' | 'playing';
export interface LiftAllClipboard {
  items: Array<{ clip: Clip; lane: 0|1|2|3 }>;
  loopStart: number;
  loopLength: number;
}
export type Clipboard = Clip | LiftAllClipboard | null;

export interface UndoEntry {
  lanes: [Lane, Lane, Lane, Lane];
  loopIn: number;
  loopOut: number;
  loopEnabled: boolean;
}

export function snapshotTape(tape: Tape): UndoEntry {
  return {
    lanes: tape.lanes,
    loopIn: tape.loopIn,
    loopOut: tape.loopOut,
    loopEnabled: tape.loopEnabled,
  };
}

// All mutable refs that multiple hooks need to share.  Pass the whole bundle
// rather than threading 20 individual ref arguments.
export interface TapeEngineRefs {
  engineRef:                MutableRefObject<AudioEngine | null>;
  syncEngineRef:            MutableRefObject<SyncEngine | null>;
  ctrlModeRef:              MutableRefObject<OpzControlMode | null>;
  ctrlModeHandlerRef:       MutableRefObject<((event: ControlEvent) => void) | null>;
  poolRef:                  MutableRefObject<AudioPool>;
  poolDisplayRef:           MutableRefObject<AudioPool>;
  tapeRef:                  MutableRefObject<Tape>;
  transportRef:             MutableRefObject<TransportState>;
  modeRef:                  MutableRefObject<Mode>;
  snapRef:                  MutableRefObject<boolean>;
  outputLatencyMsRef:            MutableRefObject<number>;
  /** Calibrated audio input latency in ms.  Updated by the metronome calibration test.
   *  Defaults to AudioContext.inputLatency on init; used for sync-recording placement. */
  calibratedInputLatencyMsRef:   MutableRefObject<number>;
  tapeStartForRecordingRef: MutableRefObject<number>;
  recordStartWallTimeRef:   MutableRefObject<number>;
  midiStartContextTimeRef:  MutableRefObject<number>;
  loopRotateTimeoutRef:     MutableRefObject<ReturnType<typeof setTimeout> | null>;
  loopRotatingRef:          MutableRefObject<boolean>;
  armedRef:                 MutableRefObject<boolean>;
  ignoreNextMidiStartRef:   MutableRefObject<boolean>;
  clocksSinceStartRef:      MutableRefObject<number>;
  cancelCountInRef:         MutableRefObject<(() => void) | null>;
  addLogFnRef:              MutableRefObject<(msg: string) => void>;
  viewWidthSamplesRef:      MutableRefObject<number>;
  selectedClipIdRef:        MutableRefObject<string | null>;
}
