// Minimal ambient declarations for the Web MIDI API.
// Not included in TypeScript's default lib.dom.d.ts; only the subset
// actually used by src/sync/syncEngine.ts is declared here.

interface MIDIMessageEvent extends Event {
  readonly data: Uint8Array;
}

interface MIDIInput extends EventTarget {
  readonly id: string;
  readonly name: string | null;
  onmidimessage: ((event: MIDIMessageEvent) => void) | null;
}

interface MIDIAccess {
  readonly inputs: ReadonlyMap<string, MIDIInput>;
}

interface Navigator {
  requestMIDIAccess(options?: { sysex?: boolean }): Promise<MIDIAccess>;
}
