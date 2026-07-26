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

  /** Returns all buffers — used by session serialization. */
  getAllBuffers(): Map<AudioBufferId, Float32Array> {
    return new Map(this.buffers);
  }

  /** Restores a buffer with a specific id (used during session load). */
  restore(id: AudioBufferId, samples: Float32Array): void {
    this.buffers.set(id, samples);
    // Advance counter past any numeric suffix to avoid id collisions.
    const n = parseInt(id.replace('buf-', ''), 10);
    if (!isNaN(n) && n >= this.counter) this.counter = n + 1;
  }
}
