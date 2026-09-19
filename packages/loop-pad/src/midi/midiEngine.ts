// MIDI I/O for the sampler: decodes Note On/Off, Control Change, and
// realtime Clock/Start/Stop messages from a single selected input, and can
// send Start/Stop to a single selected output (used for count-in transport
// control). Deliberately simpler than Tape's SyncEngine — the sampler needs
// no audio-rate transport estimate, only note/CC routing and beat counting.

const STATUS_NOTE_OFF = 0x80;
const STATUS_NOTE_ON = 0x90;
const STATUS_CONTROL_CHANGE = 0xb0;
const STATUS_CLOCK = 0xf8;
const STATUS_START = 0xfa;
const STATUS_CONTINUE = 0xfb;
const STATUS_STOP = 0xfc;

export type MidiEvent =
  | { type: 'noteon'; note: number; velocity: number; channel: number }
  | { type: 'noteoff'; note: number; channel: number }
  | { type: 'cc'; controller: number; value: number; channel: number }
  | { type: 'clock'; timeStamp: number }
  | { type: 'start' }
  | { type: 'stop' };

export interface MidiDeviceRef {
  id: string;
  name: string | null;
}

export class MidiEngine {
  private access: MIDIAccess | null = null;
  private inputId: string | null = null;
  private outputId: string | null = null;
  private listeners = new Set<(event: MidiEvent) => void>();

  async init(): Promise<void> {
    this.access = await navigator.requestMIDIAccess();
  }

  dispose(): void {
    for (const input of this.access?.inputs.values() ?? []) input.onmidimessage = null;
    this.listeners.clear();
    this.access = null;
    this.inputId = null;
    this.outputId = null;
  }

  listInputs(): MidiDeviceRef[] {
    if (!this.access) return [];
    return Array.from(this.access.inputs.values()).map((input) => ({ id: input.id, name: input.name }));
  }

  listOutputs(): MidiDeviceRef[] {
    if (!this.access) return [];
    return Array.from(this.access.outputs.values()).map((output) => ({ id: output.id, name: output.name }));
  }

  get selectedInputId(): string | null {
    return this.inputId;
  }

  setInputDevice(id: string | null): void {
    this.inputId = id;
    if (!this.access) return;
    for (const input of this.access.inputs.values()) {
      input.onmidimessage = input.id === id ? (event) => this.handleMessage(event) : null;
    }
  }

  get selectedOutputId(): string | null {
    return this.outputId;
  }

  setOutputDevice(id: string | null): void {
    this.outputId = id;
  }

  on(listener: (event: MidiEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  sendStart(): void {
    this.getOutput()?.send([STATUS_START]);
  }

  sendStop(): void {
    this.getOutput()?.send([STATUS_STOP]);
  }

  private getOutput(): MIDIOutput | null {
    if (!this.access || !this.outputId) return null;
    return this.access.outputs.get(this.outputId) ?? null;
  }

  private handleMessage(event: MIDIMessageEvent): void {
    const data = event.data;
    if (!data || data.length === 0) return;
    const status = data[0]!;
    const kind = status & 0xf0;
    const channel = status & 0x0f;

    if (status === STATUS_CLOCK) {
      this.emit({ type: 'clock', timeStamp: event.timeStamp });
      return;
    }
    if (status === STATUS_START || status === STATUS_CONTINUE) {
      this.emit({ type: 'start' });
      return;
    }
    if (status === STATUS_STOP) {
      this.emit({ type: 'stop' });
      return;
    }
    if (kind === STATUS_NOTE_ON) {
      const velocity = data[2] ?? 0;
      if (velocity === 0) this.emit({ type: 'noteoff', note: data[1] ?? 0, channel });
      else this.emit({ type: 'noteon', note: data[1] ?? 0, velocity, channel });
      return;
    }
    if (kind === STATUS_NOTE_OFF) {
      this.emit({ type: 'noteoff', note: data[1] ?? 0, channel });
      return;
    }
    if (kind === STATUS_CONTROL_CHANGE) {
      this.emit({ type: 'cc', controller: data[1] ?? 0, value: data[2] ?? 0, channel });
    }
  }

  private emit(event: MidiEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
