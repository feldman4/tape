export type PortDirection = 'input' | 'output';
export type PortInfo = { id: string; name: string | null; state: MIDIPortDeviceState };

export class MidiDevices {
  private readonly access: MIDIAccess;

  constructor(access: MIDIAccess) {
    this.access = access;
  }

  onStateChange(listener: () => void): void {
    this.access.onstatechange = listener;
  }

  dispose(): void {
    this.access.onstatechange = null;
    for (const input of this.access.inputs.values()) input.onmidimessage = null;
  }

  ports(direction: PortDirection): PortInfo[] {
    const ports: Iterable<MIDIPort> = direction === 'input' ? this.access.inputs.values() : this.access.outputs.values();
    return Array.from(ports, (port) => ({ id: port.id, name: port.name, state: port.state }));
  }

  configureInputs(irigId: string, opzId: string, irig: (bytes: Uint8Array, time: number) => void, opz: (bytes: Uint8Array, time: number) => void): boolean {
    for (const input of this.access.inputs.values()) input.onmidimessage = null;
    const irigInput = this.access.inputs.get(irigId);
    const opzInput = this.access.inputs.get(opzId);
    if (irigInput && opzInput && irigInput.id === opzInput.id) return false;
    if (irigInput) irigInput.onmidimessage = (event) => { if (event.data) irig(event.data, event.timeStamp); };
    if (opzInput) opzInput.onmidimessage = (event) => { if (event.data) opz(event.data, event.timeStamp); };
    return true;
  }

  send(id: string, bytes: number[]): boolean {
    const output = this.access.outputs.get(id);
    if (!output || output.state !== 'connected') return false;
    output.send(bytes);
    return true;
  }
}
