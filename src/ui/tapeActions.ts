// TapeAction — all user and engine intents that modify tape state.
// Produced by input adapters (keyboard/MIDI/canvas) and engine callbacks.
// Consumed exclusively by useTapeDispatch.
export type TapeAction =
  // ── Transport ─────────────────────────────────────────────────────────────
  | { type: 'record' }
  /** OP-Z group-15 audio mute requests arm/record when enabled, or disarm/stop when disabled. */
  | { type: 'setRecordEnabled'; enabled: boolean }
  | { type: 'play' }
  | { type: 'stop' }
  // ── Engine events ─────────────────────────────────────────────────────────
  /** MIDI clock start: always drives transport.  startSamples = nearest beat to playhead. */
  | { type: 'midiClockStart'; startSamples: number }
  /** MIDI clock stop received: stops transport or rewinds if already idle. */
  | { type: 'midiClockStop' }
  /** Worklet reported playback stopped while transport was 'playing'. */
  | { type: 'workletPlaybackStopped' }
  // ── Navigation ────────────────────────────────────────────────────────────
  | { type: 'selectLane'; lane: 0|1|2|3 }
  | { type: 'toggleMuteLane'; lane: 0|1|2|3 }
  // ── Encoder ───────────────────────────────────────────────────────────────
  /** Device-agnostic encoder nudge (OP-Z hardware or keyboard+mouse simulation). */
  | { type: 'encoderNudge'; index: 0|1|2|3; delta: number; shift: boolean }
  // ── Editing ───────────────────────────────────────────────────────────────
  | { type: 'split' }
  | { type: 'join' }
  | { type: 'lift' }
  | { type: 'liftAll' }
  | { type: 'drop' }
  | { type: 'mergeDrop' }
  | { type: 'undo' }
  | { type: 'redo' }
  // ── Loop ──────────────────────────────────────────────────────────────────
  | { type: 'setLoopIn' }
  | { type: 'setLoopOut' }
  | { type: 'toggleLoop' }
  | { type: 'loopFromClip' }
  // ── Mixer ─────────────────────────────────────────────────────────────────
  | { type: 'setLaneGain'; lane: 0|1|2|3; gain: number }
  | { type: 'setLanePan';  lane: 0|1|2|3; pan:  number }
  | { type: 'setRecordingGain'; gain: number }
  // ── Settings ──────────────────────────────────────────────────────────────
  | { type: 'toggleMode' }
  | { type: 'toggleSnap' }
  // ── Session ───────────────────────────────────────────────────────────────
  | { type: 'saveSession' }
  | { type: 'loadSession'; name: string }
  | { type: 'newSession' }
  | { type: 'deleteSession'; name: string };
