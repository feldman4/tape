// Immutable audio buffer storage (Stage 0: in-memory only, no persistence).
// Recording creates new buffers here; editing never mutates them.

export type AudioBufferId = string;

export class AudioPool {
  private buffers = new Map<AudioBufferId, Float32Array>();
  private counter = 0;

  add(samples: Float32Array): AudioBufferId {
    const id = `buf-${this.counter++}`;
    this.buffers.set(id, samples);
    return id;
  }

  get(id: AudioBufferId): Float32Array | undefined {
    return this.buffers.get(id);
  }
}
