import type { Send } from './scenes.ts';

type HistoryEntry = { time: number; before: number | null; after: number };
const values = (width: number) => Array.from({ length: 16 }, () => Array<number | null>(width).fill(null));

export class ParameterState {
  // The diagnostics input includes received values and assumed calibration values.
  readonly observed = values(16);
  // DATA adjustments also use successful drum commands not shown as diagnostic input.
  readonly parameterValues = values(16);
  readonly fxBase = values(128);
  readonly lastSent = values(128);
  readonly outputValues = values(16);
  readonly history = Array.from({ length: 16 }, () => Array.from({ length: 16 }, () => Array<HistoryEntry>()));

  // Only successful sends establish an FX base or the last value delivered to Ableton.
  sendTracked(send: Send, destination: Parameters<Send>[0], bytes: number[]): boolean {
    const sent = send(destination, bytes);
    if (sent && bytes.length === 3 && (bytes[0] & 0xf0) === 0xb0) {
      const channel = bytes[0] & 15;
      if (destination === 'opz' && bytes[1] >= 1 && bytes[1] <= 16) this.fxBase[channel][bytes[1]] = bytes[2];
      if (destination === 'iac') this.lastSent[channel][bytes[1]] = bytes[2];
    }
    return sent;
  }

  observeBase(channel: number, cc: number, value: number): void {
    this.fxBase[channel][cc] = value;
  }

  recordInput(channel: number, cc: number, value: number): void {
    this.observed[channel][cc - 1] = value;
    this.parameterValues[channel][cc - 1] = value;
  }

  setParameter(channel: number, cc: number, value: number): void {
    this.parameterValues[channel][cc - 1] = value;
  }

  recordOutput(channel: number, cc: number, before: number | null, after: number): void {
    this.outputValues[channel][cc - 1] = after;
    const history = this.history[channel][cc - 1];
    history.push({ time: Date.now(), before, after });
    if (history.length > 100) history.shift();
  }

  reset(): void {
    for (const table of [this.observed, this.parameterValues, this.fxBase, this.lastSent, this.outputValues]) {
      for (const row of table) row.fill(null);
    }
    for (const row of this.history) for (const entries of row) entries.length = 0;
  }
}
