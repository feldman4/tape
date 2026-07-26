// Sync Engine (Stage 0, minimal): parses MIDI Clock/Start/Stop, derives a
// smoothed tempo from clock inter-pulse intervals, and provides the
// Samples <-> Beats correlation needed by Sync-mode recording.
//
// Web MIDI event timestamps live in the performance.now() time domain, while
// the audio engine's sample clock lives in the AudioContext time domain.
// AudioContext.getOutputTimestamp() gives a paired (contextTime, performanceTime)
// sample that lets us convert any MIDI timestamp into an absolute sample frame.

const CLOCK_PULSES_PER_QUARTER_NOTE = 24;
const TEMPO_SMOOTHING_WINDOW = 24; // ~1 beat of clock pulses

const STATUS_NOTE_OFF = 0x80;
const STATUS_NOTE_ON = 0x90;
const STATUS_CLOCK = 0xf8;
const STATUS_START = 0xfa;
const STATUS_CONTINUE = 0xfb;
const STATUS_STOP = 0xfc;

export type SyncEvent =
  | { type: 'start' }
  | { type: 'stop' }
  | { type: 'clock'; beatPosition: number; bpm: number; frame: number };

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

  constructor(audioContext: AudioContext) {
    this.audioContext = audioContext;
  }

  async init(): Promise<void> {
    this.midiAccess = await navigator.requestMIDIAccess();
    this.setInputDevice('all');
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
  sendStart(): void {
    this.getOutput()?.send([STATUS_START]);
  }

  /** Sends MIDI Stop. */
  sendStop(): void {
    this.getOutput()?.send([STATUS_STOP]);
  }

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

  private perfTimeToFrame(perfTimeMs: number): number {
    const { contextTime, performanceTime } = this.audioContext.getOutputTimestamp();
    if (contextTime === undefined || performanceTime === undefined) {
      return Math.round(this.audioContext.currentTime * this.audioContext.sampleRate);
    }
    const deltaSeconds = (perfTimeMs - performanceTime) / 1000;
    const frameTime = contextTime + deltaSeconds;
    return Math.round(frameTime * this.audioContext.sampleRate);
  }

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
        const frame = this.perfTimeToFrame(perfTime);
        this.emit({ type: 'clock', beatPosition: this.beatPosition, bpm: this.bpm, frame });
      }
    }
  }

  private emit(event: SyncEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
