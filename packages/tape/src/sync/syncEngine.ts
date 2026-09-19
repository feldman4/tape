// Sync Engine: parses MIDI Clock/Start/Stop, derives a smoothed tempo from
// clock inter-pulse intervals, and maintains a TransportEstimate — a
// phase-locked estimate of tape-time as a function of browser time.
//
// Web MIDI event timestamps live in the performance.now() time domain, while
// the audio engine's sample clock lives in the AudioContext time domain.
// AudioContext.getOutputTimestamp() gives a paired (contextTime, performanceTime)
// sample that lets us convert any MIDI timestamp into an absolute audio-context time.
//
// Transport model (see docs/new_timing_model.md):
//
//   tape_time(browser_time) = tapeSecs + (browser_time - browserTimeSecs) * speed
//
// On STATUS_START the estimate is hard-reset.  Subsequent STATUS_CLOCK messages
// apply small PLL phase and speed corrections to eliminate accumulated jitter.
// The consumer calls setStartTapeOffset() synchronously after receiving 'start'
// to anchor the estimate to the desired tape position.

const CLOCK_PULSES_PER_QUARTER_NOTE = 24;
const TEMPO_SMOOTHING_WINDOW = 24; // ~1 beat of clock pulses

// PLL gains — conservative enough to absorb USB jitter without over-correcting.
const PHASE_GAIN = 0.1;
const SPEED_GAIN = 0.02;

const STATUS_NOTE_OFF = 0x80;
const STATUS_NOTE_ON = 0x90;
const STATUS_CLOCK = 0xf8;
const STATUS_START = 0xfa;
const STATUS_CONTINUE = 0xfb;
const STATUS_STOP = 0xfc;

/** Tape position as a linear function of browser time.  All quantities in seconds. */
export interface TransportEstimate {
  /** MIDI-latency-corrected anchor time in the performance.now() domain (seconds). */
  browserTimeSecs: number;
  /** Tape position (seconds) at the anchor time. */
  tapeSecs: number;
  /** Playback speed ratio (1.0 = real-time; PLL adjusts to remove long-term drift). */
  speed: number;
}

export type SyncEvent =
  | { type: 'start' }
  | { type: 'stop' }
  | {
      type: 'clock';
      beatPosition: number;
      /** Integer beat index since last Start (increments every 24 pulses). */
      beatIndex: number;
      bpm: number;
      frame: number;
      /** AudioContext time (seconds) of this pulse, MIDI-latency-corrected.
       *  Use for scheduling audio that should align with this beat. */
      contextTimeSecs: number;
    };

export class SyncEngine {
  private audioContext: AudioContext;
  private midiAccess: MIDIAccess | null = null;
  private selectedInputId: string | 'all' | null = null;
  private selectedOutputId: string | null = null;
  private running = false;
  private clockCount = 0; // pulses since the last Start, 24 per quarter note
  private lastClockPerfTime: number | null = null;
  private intervalsMs: number[] = [];
  private listeners = new Set<(event: SyncEvent) => void>();

  // ── Transport estimate (PLL) ─────────────────────────────────────────────
  private _transportEst: TransportEstimate | null = null;
  private _startTapeOffsetSecs = 0; // tape position mapped to the last STATUS_START moment
  private _midiLatencyMs = 2;       // estimated USB MIDI message latency

  constructor(audioContext: AudioContext) {
    this.audioContext = audioContext;
  }

  // ── MIDI access ──────────────────────────────────────────────────────────

  async init(): Promise<void> {
    this.midiAccess = await navigator.requestMIDIAccess();
    this.setInputDevice('all');
  }

  dispose(): void {
    for (const input of this.midiAccess?.inputs.values() ?? []) input.onmidimessage = null;
    this.listeners.clear();
    this.midiAccess = null;
    this.selectedInputId = null;
    this.selectedOutputId = null;
    this.running = false;
  }

  /** Lists available MIDI input devices. */
  listInputs(): { id: string; name: string | null }[] {
    if (!this.midiAccess) return [];
    return Array.from(this.midiAccess.inputs.values()).map((input) => ({ id: input.id, name: input.name }));
  }

  get selectedInput(): string | 'all' | null {
    return this.selectedInputId;
  }

  /** Selects which MIDI input(s) to listen to: a specific input id, or 'all'. */
  setInputDevice(id: string | 'all'): void {
    if (!this.midiAccess) return;
    this.selectedInputId = id;
    for (const input of this.midiAccess.inputs.values()) {
      input.onmidimessage = id === 'all' || input.id === id ? (event) => this.handleMessage(event) : null;
    }
  }

  on(listener: (event: SyncEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Lists available MIDI output devices (e.g. the OP-Z's USB MIDI port). */
  listOutputs(): { id: string; name: string | null }[] {
    if (!this.midiAccess) return [];
    return Array.from(this.midiAccess.outputs.values()).map((output) => ({ id: output.id, name: output.name }));
  }

  get selectedOutput(): string | null {
    return this.selectedOutputId;
  }

  /** Selects which MIDI output to send to. */
  setOutputDevice(id: string | null): void {
    this.selectedOutputId = id;
  }

  /** Returns the underlying MIDIAccess so other consumers (e.g. OpzControlMode)
   *  can share the same access object without a second requestMIDIAccess() call. */
  getMIDIAccess(): MIDIAccess | null {
    return this.midiAccess;
  }

  private getOutput(): MIDIOutput | null {
    if (!this.midiAccess || !this.selectedOutputId) return null;
    return this.midiAccess.outputs.get(this.selectedOutputId) ?? null;
  }

  /** Sends a Note On. `channel` is 0-based (0 = MIDI channel 1, the OP-Z's percussion track). */
  sendNoteOn(note: number, velocity = 100, channel = 0): void {
    this.getOutput()?.send([STATUS_NOTE_ON | (channel & 0x0f), note & 0x7f, velocity & 0x7f]);
  }

  sendNoteOff(note: number, channel = 0): void {
    this.getOutput()?.send([STATUS_NOTE_OFF | (channel & 0x0f), note & 0x7f, 0]);
  }

  /** Sends MIDI Start, telling an external sequencer (e.g. the OP-Z) to begin playback and emit Clock. */
  sendStart(): boolean {
    const output = this.getOutput();
    if (!output) return false;
    output.send([STATUS_START]);
    return true;
  }

  /** Sends MIDI Stop. */
  sendStop(): void {
    this.getOutput()?.send([STATUS_STOP]);
  }

  // ── Tempo ────────────────────────────────────────────────────────────────

  get bpm(): number {
    if (this.intervalsMs.length === 0) return 120;
    const avgMs = this.intervalsMs.reduce((a, b) => a + b, 0) / this.intervalsMs.length;
    const quarterNoteMs = avgMs * CLOCK_PULSES_PER_QUARTER_NOTE;
    return 60000 / quarterNoteMs;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Current elapsed beats since the last Start message (fractional quarter notes). */
  get beatPosition(): number {
    return this.clockCount / CLOCK_PULSES_PER_QUARTER_NOTE;
  }

  samplesPerBeat(): number {
    return (60 / this.bpm) * this.audioContext.sampleRate;
  }

  // ── Transport estimate ───────────────────────────────────────────────────

  /** Estimated MIDI USB message latency in milliseconds (default: 2 ms). */
  get midiLatencyMs(): number {
    return this._midiLatencyMs;
  }

  set midiLatencyMs(ms: number) {
    this._midiLatencyMs = ms;
  }

  /** Current PLL transport estimate, or null before the first STATUS_START. */
  get transportEstimate(): TransportEstimate | null {
    return this._transportEst;
  }

  /**
   * Sets the tape position that maps to the last STATUS_START moment.
   * Call this synchronously after receiving the 'start' event to anchor
   * playback to a specific tape position (e.g. nearest beat to the playhead).
   * Defaults to 0 if not called.
   */
  setStartTapeOffset(tapeSecs: number): void {
    this._startTapeOffsetSecs = tapeSecs;
    if (this._transportEst) {
      this._transportEst = { ...this._transportEst, tapeSecs };
    }
  }

  /**
   * Evaluates the PLL transport estimate at an arbitrary browser time.
   * Returns null before the first STATUS_START.
   *
   * @param browserTimeSecs  performance.now() / 1000
   */
  tapeTimeAt(browserTimeSecs: number): number | null {
    const est = this._transportEst;
    if (!est) return null;
    return est.tapeSecs + (browserTimeSecs - est.browserTimeSecs) * est.speed;
  }

  // ── Conversion helpers ───────────────────────────────────────────────────

  private perfTimeToFrame(perfTimeMs: number): number {
    const { contextTime, performanceTime } = this.audioContext.getOutputTimestamp();
    if (contextTime === undefined || performanceTime === undefined) {
      return Math.round(this.audioContext.currentTime * this.audioContext.sampleRate);
    }
    const deltaSeconds = (perfTimeMs - performanceTime) / 1000;
    const frameTime = contextTime + deltaSeconds;
    return Math.round(frameTime * this.audioContext.sampleRate);
  }

  /**
   * Converts a MIDI perf timestamp (ms) to an AudioContext time (seconds),
   * subtracting MIDI latency so the result reflects when the event truly occurred.
   */
  perfTimeToContextSecs(perfTimeMs: number): number {
    const { contextTime, performanceTime } = this.audioContext.getOutputTimestamp();
    if (contextTime === undefined || performanceTime === undefined) {
      return this.audioContext.currentTime - this._midiLatencyMs / 1000;
    }
    return contextTime + (perfTimeMs - performanceTime) / 1000 - this._midiLatencyMs / 1000;
  }

  // ── Message handler ──────────────────────────────────────────────────────

  private handleMessage(event: MIDIMessageEvent): void {
    const data = event.data;
    if (!data || data.length === 0) return;
    const status = data[0];
    const perfTime = (event as unknown as Event & { timeStamp: number }).timeStamp;

    if (status === STATUS_START) {
      this.running = true;
      this.clockCount = 0;
      this.intervalsMs = [];
      this.lastClockPerfTime = null;
      this._startTapeOffsetSecs = 0; // consumer calls setStartTapeOffset() after 'start'
      const anchorTimeSecs = (perfTime - this._midiLatencyMs) / 1000;
      this._transportEst = { browserTimeSecs: anchorTimeSecs, tapeSecs: 0, speed: 1.0 };
      this.emit({ type: 'start' });
      return;
    }

    if (status === STATUS_CONTINUE) {
      this.running = true;
      return;
    }

    if (status === STATUS_STOP) {
      this.running = false;
      this.emit({ type: 'stop' });
      return;
    }

    if (status === STATUS_CLOCK) {
      if (this.lastClockPerfTime !== null) {
        this.intervalsMs.push(perfTime - this.lastClockPerfTime);
        if (this.intervalsMs.length > TEMPO_SMOOTHING_WINDOW) this.intervalsMs.shift();
      }
      this.lastClockPerfTime = perfTime;

      if (this.running) {
        this.clockCount += 1;

        // PLL: nudge the estimate toward the observed tape position for this pulse.
        if (this._transportEst && this.intervalsMs.length > 0) {
          const correctedBrowserTimeSecs = (perfTime - this._midiLatencyMs) / 1000;
          const secsPerBeat = 60 / this.bpm;
          const observedTapeSecs =
            this._startTapeOffsetSecs + (this.clockCount / CLOCK_PULSES_PER_QUARTER_NOTE) * secsPerBeat;
          const predicted =
            this._transportEst.tapeSecs +
            (correctedBrowserTimeSecs - this._transportEst.browserTimeSecs) * this._transportEst.speed;
          const error = observedTapeSecs - predicted;
          this._transportEst = {
            browserTimeSecs: this._transportEst.browserTimeSecs,
            tapeSecs: this._transportEst.tapeSecs + PHASE_GAIN * error,
            speed: Math.max(0.5, Math.min(2.0, this._transportEst.speed + SPEED_GAIN * error)),
          };
        }

        const frame = this.perfTimeToFrame(perfTime);
        const contextTimeSecs = this.perfTimeToContextSecs(perfTime);
        const beatIndex = Math.floor(this.clockCount / CLOCK_PULSES_PER_QUARTER_NOTE);
        this.emit({
          type: 'clock',
          beatPosition: this.beatPosition,
          beatIndex,
          bpm: this.bpm,
          frame,
          contextTimeSecs,
        });
      }
    }
  }

  private emit(event: SyncEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
