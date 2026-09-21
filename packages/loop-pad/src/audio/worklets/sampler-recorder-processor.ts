// AudioWorkletProcessor — concurrent per-slot sample recorder.
// Unlike tape-processor (one continuous duplex lane), this processor only
// captures raw input audio into one or more independently armed slots at a
// time (any subset of the 16 sampler slots may record simultaneously) and
// reports periodic peak levels so the UI can draw live recording progress.
// Sample playback is handled on the main thread with AudioBufferSourceNode
// chains (see ../samplerEngine.ts) since one-shot slot playback needs no
// sample-accurate cross-slot mixing the way tape's multi-clip lane does.

type ToProcessorMessage =
  | { type: 'arm'; slot: number }
  | { type: 'snapshot'; slot: number }
  | { type: 'flush'; slot: number }
  | { type: 'discard'; slot: number };

type FromProcessorMessage =
  | { type: 'recorded'; slot: number; samples: { left: Float32Array; right: Float32Array } }
  | { type: 'snapshot'; slot: number; samples: { left: Float32Array; right: Float32Array } }
  | { type: 'progress'; slot: number; peak: number };

const PROGRESS_POST_INTERVAL_BLOCKS = 4; // ~12ms @128/44.1kHz — smooth ring animation

class SamplerRecorderProcessor extends AudioWorkletProcessor {
  private chunks = new Map<number, { left: Float32Array[]; right: Float32Array[] }>();
  private blockCounter = 0;

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<ToProcessorMessage>) => this.handleMessage(event.data);
  }

  private handleMessage(msg: ToProcessorMessage): void {
    switch (msg.type) {
      case 'arm':
        this.chunks.set(msg.slot, { left: [], right: [] });
        break;
      case 'snapshot':
        this.sendSamples(msg.slot, 'snapshot', false);
        break;
      case 'flush':
        this.sendSamples(msg.slot, 'recorded', true);
        break;
      case 'discard':
        this.chunks.delete(msg.slot);
        break;
    }
  }

  private sendSamples(slot: number, type: 'recorded' | 'snapshot', discard: boolean): void {
    const parts = this.chunks.get(slot);
    if (discard) this.chunks.delete(slot);
    if (!parts) return;
    const total = parts.left.reduce((sum, chunk) => sum + chunk.length, 0);
    const left = new Float32Array(total);
    const right = new Float32Array(total);
    let offset = 0;
    for (let index = 0; index < parts.left.length; index++) {
      const leftChunk = parts.left[index]!;
      left.set(leftChunk, offset);
      right.set(parts.right[index]!, offset);
      offset += leftChunk.length;
    }
    const message: FromProcessorMessage = { type, slot, samples: { left, right } };
    this.port.postMessage(message, [left.buffer, right.buffer]);
  }

  process(inputs: Float32Array[][]): boolean {
    const left = inputs[0]?.[0];
    const right = inputs[0]?.[1];
    if (left && right && this.chunks.size > 0) {
      for (const parts of this.chunks.values()) {
        parts.left.push(left.slice());
        parts.right.push(right.slice());
      }

      this.blockCounter += 1;
      if (this.blockCounter >= PROGRESS_POST_INTERVAL_BLOCKS) {
        this.blockCounter = 0;
        for (const slot of this.chunks.keys()) {
          let peak = 0;
          for (let i = 0; i < left.length; i++) peak = Math.max(peak, Math.abs(left[i]!), Math.abs(right[i]!));
          const message: FromProcessorMessage = { type: 'progress', slot, peak };
          this.port.postMessage(message);
        }
      }
    }
    return true;
  }
}

registerProcessor('sampler-recorder-processor', SamplerRecorderProcessor);
