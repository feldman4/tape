// OpzControlMode — OP-Z MIDI channel 15 ("lights" track) control surface.
//
// The OP-Z is plugged in as a class-compliant USB MIDI device; channel 15
// (0-indexed: 14) is its "track 15" (lights) row, which we commandeer as a
// tape-controller surface to mirror OP-1 Field tape-mode ergonomics.
//
// RELATIVE ENCODERS (CC 1–3)
//   The OP-Z always emits absolute CC values (0–127). To use CC 1–3 as
//   continuous relative encoders (e.g. for scrubbing) we:
//     1. Track the last-seen absolute value per encoder.
//     2. Emit the *delta* (current − previous) as an 'encoderDelta' event.
//     3. When the absolute value drifts more than CC_RESET_THRESHOLD from
//        center (64) we send a CC message back to the OP-Z resetting that
//        encoder to 64, and update our tracking accordingly.
//   This keeps the encoder near centre so it always has headroom in both
//   directions, without the user having to physically re-centre it.
//
// RECORD STATE (CC 4)
//   CC 4 is not centred or reset. Zero represents record off and 127 record
//   on. From either endpoint, moving away requests the opposite record state.
//
// BLACK KEYS  (sharps/flats)
//   54  F#3  →  Tape 1
//   56  G#3  →  Tape 2
//   58  A#3  →  Tape 3
//   61  C#4  →  Tape 4
//   63  D#4  →  Lift
//   66  F#4  →  Drop
//   68  G#4  →  Split
//   70  A#4  →  Loop out (shift: Loop in)
//   73  C#5  →  Loop toggle (shift: Loop clip)
//   75  D#5  →  Shift  (modifier; held while pressing other keys or turning
//                       encoders to access secondary actions, matching the
//                       OP-1 Field shift convention)
//
// SHIFT MODIFIER
//   While Shift (75) is held, 'encoderDelta' events carry shift=true. The
//   consumer maps encoder 1 to scrub/slide, encoder 2 to shifting the loop
//   region, and encoder 3 to loop out. CC 4 controls recording state.
//
// INTEGRATION
//   OpzControlMode shares the same MIDIAccess as SyncEngine.  It uses
//   addEventListener('midimessage') rather than onmidimessage, so the two
//   coexist on the same MIDI input without conflict.

const CONTROL_CHANNEL = 14; // MIDI channel 15, 0-indexed

// Status bytes for channel 15
const STATUS_NOTE_OFF = 0x80 | CONTROL_CHANNEL; // 0x8E
const STATUS_NOTE_ON  = 0x90 | CONTROL_CHANNEL; // 0x9E
const STATUS_CC       = 0xb0 | CONTROL_CHANNEL; // 0xBE

// ── Encoder constants ──────────────────────────────────────────────────────

/** CC numbers for the relative OP-Z encoders on channel 15. */
const ENCODER_CC = [1, 2, 3] as const;
type EncoderIndex = 0 | 1 | 2;

/** Absolute CC value we treat as neutral / centre. */
const CC_CENTER = 64;

/**
 * If |ccValue - CC_CENTER| exceeds this we send a reset CC back to the OP-Z
 * to recentre the encoder before it hits the 0 or 127 rail.
 */
const CC_RESET_THRESHOLD = 30;

const CC_RECORD_STATE = 4;
const CC_MIN = 0;
const CC_MAX = 127;
const NOTE_TAPE = [54, 56, 58, 61] as const; // F#3, G#3, A#3, C#4
const NOTE_LIFT = 63; // D#4
const NOTE_DROP = 66; // F#4
const NOTE_SPLIT = 68; // G#4
const NOTE_LOOP = 70; // A#4
const NOTE_LOOP_TOGGLE = 73; // C#5

// Modifier
const NOTE_SHIFT = 75; // D#5

// ── Public event types ──────────────────────────────────────────────────────

export type ControlEvent =
  /** CC 4 requests a change to Tape's Sync recording state. */
  | { type: 'recordState'; enabled: boolean }
  // ── Tape edit ────────────────────────────────────────────────────────────
  /** Lift active clip to clipboard (F#3 / 54).  Shift: lift all in loop. */
  | { type: 'lift';  shift: boolean }
  /** Drop clipboard clip at playhead (G#3 / 56).  Shift: merge drop. */
  | { type: 'drop';  shift: boolean }
  /** Split active clip at playhead (A#3 / 58).  Shift: join. */
  | { type: 'split'; shift: boolean }
  // ── Loop ─────────────────────────────────────────────────────────────────
  /** Set loop out at playhead (A#4 / 70). Shift: set loop in. */
  | { type: 'loop'; shift: boolean }
  /** Toggle loop on/off (C#5 / 73).  Shift: loop current clip. */
  | { type: 'loopToggle'; shift: boolean }
  /** Select active tape lane 0-3. Shift: mute/unmute. */
  | { type: 'selectLane'; lane: 0 | 1 | 2 | 3; shift: boolean }
  /** Shift plus the standard OP-Z Stop message selects Tape's grid setting. */
  | { type: 'grid' }
  // ── Modifier / encoder ───────────────────────────────────────────────────
  /** Shift key state changed (D#5 / 75). */
  | { type: 'shiftChange'; held: boolean }
  /**
   * One of the four encoders moved.
   * `index` is 0-based (encoder 1 → 0, …, encoder 4 → 3).
   * `delta` is the signed relative change derived from the absolute CC stream.
   * `shift` reflects whether the Shift key is currently held.
   */
  | { type: 'encoderDelta'; index: EncoderIndex; delta: number; shift: boolean };

// ── Class ───────────────────────────────────────────────────────────────────

export class OpzControlMode {
  private midiAccess: MIDIAccess;
  private selectedInputId: string | 'all' | null = null;
  private selectedOutputId: string | null = null;
  private listeners = new Set<(event: ControlEvent) => void>();

  // Last-seen absolute CC value per relative encoder, initialised to centre.
  private ccValues: [number, number, number] = [CC_CENTER, CC_CENTER, CC_CENTER];
  private recordEnabled = false;

  private shiftHeld = false;

  // Stable reference so addEventListener / removeEventListener round-trip works.
  private boundHandler: (event: MIDIMessageEvent) => void;

  constructor(midiAccess: MIDIAccess) {
    this.midiAccess = midiAccess;
    this.boundHandler = (e: MIDIMessageEvent) => this.handleMessage(e);
  }

  // ── Input / output selection ─────────────────────────────────────────────

  /**
   * Attach to a specific MIDI input id, or 'all' inputs.
   * Detaches from any previously-selected input first.
   */
  setInputDevice(id: string | 'all'): void {
    if (this.selectedInputId !== null) {
      for (const input of this.midiAccess.inputs.values()) {
        if (this.selectedInputId === 'all' || input.id === this.selectedInputId) {
          input.removeEventListener('midimessage', this.boundHandler);
        }
      }
    }
    this.selectedInputId = id;
    for (const input of this.midiAccess.inputs.values()) {
      if (id === 'all' || input.id === id) {
        input.addEventListener('midimessage', this.boundHandler);
      }
    }
  }

  setOutputDevice(id: string | null): void {
    this.selectedOutputId = id;
  }

  get selectedInput(): string | 'all' | null {
    return this.selectedInputId;
  }

  get selectedOutput(): string | null {
    return this.selectedOutputId;
  }

  /** Remove all listeners and detach from MIDI inputs. */
  dispose(): void {
    if (this.selectedInputId !== null) {
      for (const input of this.midiAccess.inputs.values()) {
        input.removeEventListener('midimessage', this.boundHandler);
      }
    }
    this.listeners.clear();
  }

  // ── Event subscription ───────────────────────────────────────────────────

  on(listener: (event: ControlEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ── State accessors ──────────────────────────────────────────────────────

  get isShiftHeld(): boolean {
    return this.shiftHeld;
  }

  /** Mirrors Tape's record state to CC 4 so the OP-Z track-15 LED stays current. */
  setRecordEnabled(enabled: boolean): void {
    this.recordEnabled = enabled;
    this.getOutput()?.send([STATUS_CC, CC_RECORD_STATE, enabled ? CC_MAX : CC_MIN]);
  }

  // ── Private MIDI handling ────────────────────────────────────────────────

  private getOutput(): MIDIOutput | null {
    if (!this.selectedOutputId) return null;
    return this.midiAccess.outputs.get(this.selectedOutputId) ?? null;
  }

  private handleMessage(event: MIDIMessageEvent): void {
    const data = event.data;
    if (!data || data.length === 0) return;
    const status = data[0]!;

    if (status === 0xfc) {
      if (this.shiftHeld) this.emit({ type: 'grid' });
      return;
    }

    if (status === STATUS_CC && data.length >= 3) {
      this.handleCC(data[1]!, data[2]!);
      return;
    }

    if (status === STATUS_NOTE_ON && data.length >= 3) {
      const note = data[1]!;
      const velocity = data[2]!;
      // velocity 0 on Note On is a conventional Note Off
      if (velocity > 0) this.handleNoteOn(note);
      else this.handleNoteOff(note);
      return;
    }

    if (status === STATUS_NOTE_OFF && data.length >= 2) {
      this.handleNoteOff(data[1]!);
    }
  }

  private handleCC(cc: number, value: number): void {
    if (cc === CC_RECORD_STATE) {
      const enabled = this.recordEnabled ? value === CC_MAX : value !== CC_MIN;
      if (enabled !== this.recordEnabled) {
        this.recordEnabled = enabled;
        this.emit({ type: 'recordState', enabled });
      }
      return;
    }

    const encIdx = ENCODER_CC.indexOf(cc as typeof ENCODER_CC[number]);
    if (encIdx === -1) return; // not one of our encoders
    const idx = encIdx as EncoderIndex;

    const delta = value - this.ccValues[idx];
    this.ccValues[idx] = value;

    if (delta !== 0) {
      this.emit({ type: 'encoderDelta', index: idx, delta, shift: this.shiftHeld });
    }

    // Recentre if the encoder is drifting toward the rail.
    if (Math.abs(value - CC_CENTER) > CC_RESET_THRESHOLD) {
      this.ccValues[idx] = CC_CENTER;
      this.getOutput()?.send([STATUS_CC, cc, CC_CENTER]);
    }
  }

  private handleNoteOn(note: number): void {
    switch (note) {
      case NOTE_SHIFT:
        this.shiftHeld = true;
        this.emit({ type: 'shiftChange', held: true });
        break;
      // Tape lanes
      case NOTE_TAPE[0]: this.emit({ type: 'selectLane', lane: 0, shift: this.shiftHeld }); break;
      case NOTE_TAPE[1]: this.emit({ type: 'selectLane', lane: 1, shift: this.shiftHeld }); break;
      case NOTE_TAPE[2]: this.emit({ type: 'selectLane', lane: 2, shift: this.shiftHeld }); break;
      case NOTE_TAPE[3]: this.emit({ type: 'selectLane', lane: 3, shift: this.shiftHeld }); break;
      // Tape edit
      case NOTE_LIFT:  this.emit({ type: 'lift',  shift: this.shiftHeld }); break;
      case NOTE_DROP:  this.emit({ type: 'drop',  shift: this.shiftHeld }); break;
      case NOTE_SPLIT: this.emit({ type: 'split', shift: this.shiftHeld }); break;
      // Loop
      case NOTE_LOOP:        this.emit({ type: 'loop', shift: this.shiftHeld }); break;
      case NOTE_LOOP_TOGGLE: this.emit({ type: 'loopToggle', shift: this.shiftHeld }); break;
      default: break;
    }
  }

  private handleNoteOff(note: number): void {
    if (note === NOTE_SHIFT) {
      this.shiftHeld = false;
      this.emit({ type: 'shiftChange', held: false });
    }
  }

  private emit(event: ControlEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
