// AudioWorkletProcessor — single duplex tape lane.
// Supports multi-clip tape playback (N clips at arbitrary tape positions, mixed),
// loop region, sample-accurate recording, and a one-shot click for latency testing.
// All timing is in absolute sample frames (`currentFrame`) or tape-relative offsets.

import { CLICK_LENGTH, createClickWaveform } from '../clickWaveform';

// A clip as sent to the worklet from the main thread.
interface WorkletClip {
  samples: Float32Array;
  tapeStart: number; // samples from tape start
  duration: number;  // samples (may be < samples.length when sourceStart > 0)
  sourceStart: number; // offset into samples[] where this clip begins
  gain: number;
  muted: boolean;
}

type ToProcessorMessage =
  | { type: 'record-start' }
  | { type: 'record-stop' }
  | { type: 'set-tape'; clips: WorkletClip[] }
  | { type: 'play'; tapeStart: number; atAudioFrame: number; loopIn: number; loopOut: number; loopEnabled: boolean }
  | { type: 'set-loop'; loopIn: number; loopOut: number; loopEnabled: boolean }
  | { type: 'stop-playback' }
  | { type: 'click'; atFrame: number };

type FromProcessorMessage =
  | { type: 'recorded'; samples: Float32Array; startFrame: number }
  | { type: 'playhead'; frame: number; tapePosition: number; playing: boolean };

const CLICK_WAVEFORM = createClickWaveform();
const PLAYHEAD_POST_INTERVAL_BLOCKS = 16; // throttle ~46ms @128/44.1kHz

class TapeProcessor extends AudioWorkletProcessor {
  private recording = false;
  private recordedChunks: Float32Array[] = [];
  private recordStartFrame = 0;

  // Tape clips (structured-clone from main thread; main thread retains originals)
  private tapeClips: WorkletClip[] = [];

  // Playback state
  private playing = false;
  private playbackTapeStart = 0;  // tape position at the start of playback
  private playbackAudioStart = 0; // absolute audio frame at which playback began
  private loopIn = 0;
  private loopOut = 0;
  private loopEnabled = false;

  private clickAtFrame: number | null = null;
  private blockCounter = 0;

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<ToProcessorMessage>) => this.handleMessage(event.data);
  }

  private handleMessage(msg: ToProcessorMessage): void {
    switch (msg.type) {
      case 'record-start':
        this.recording = true;
        this.recordedChunks = [];
        this.recordStartFrame = currentFrame;
        break;
      case 'record-stop':
        this.recording = false;
        this.flushRecording();
        break;
      case 'set-tape':
        this.tapeClips = msg.clips;
        break;
      case 'play':
        this.playbackTapeStart = msg.tapeStart;
        this.playbackAudioStart = msg.atAudioFrame;
        this.loopIn = msg.loopIn;
        this.loopOut = msg.loopOut;
        this.loopEnabled = msg.loopEnabled;
        this.playing = true;
        break;
      case 'set-loop':
        if (this.playing) {
          // Re-anchor the raw tape position to the current *effective* position
          // before applying new loop boundaries.  Without this, the accumulated
          // linear offset wraps differently with the new loopIn/loopOut and the
          // playhead jumps.
          const rawNow = this.playbackTapeStart + (currentFrame - this.playbackAudioStart);
          this.playbackTapeStart = this.effectiveTapePos(rawNow);
          this.playbackAudioStart = currentFrame;
        }
        this.loopIn = msg.loopIn;
        this.loopOut = msg.loopOut;
        this.loopEnabled = msg.loopEnabled;
        break;
      case 'stop-playback':
        this.playing = false;
        break;
      case 'click':
        this.clickAtFrame = msg.atFrame;
        break;
    }
  }

  private flushRecording(): void {
    const total = this.recordedChunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const merged = new Float32Array(total);
    let offset = 0;
    for (const chunk of this.recordedChunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    this.recordedChunks = [];
    const message: FromProcessorMessage = { type: 'recorded', samples: merged, startFrame: this.recordStartFrame };
    this.port.postMessage(message, [merged.buffer]);
  }

  /** Resolve raw tape position into effective tape position after loop wrapping. */
  private effectiveTapePos(rawTapePos: number): number {
    if (this.loopEnabled && this.loopOut > this.loopIn && rawTapePos >= this.loopIn) {
      const loopLen = this.loopOut - this.loopIn;
      return this.loopIn + ((rawTapePos - this.loopIn) % loopLen);
    }
    return rawTapePos;
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    const blockStartFrame = currentFrame;

    if (this.recording && input) {
      this.recordedChunks.push(input.slice());
    }

    if (output) {
      output.fill(0);
      const blockSize = output.length;

      if (this.playing && this.tapeClips.length > 0) {
        for (let i = 0; i < blockSize; i++) {
          const rawTapePos = this.playbackTapeStart + (blockStartFrame + i - this.playbackAudioStart);

          // Stop playback if we've gone past all clip content and loop is off.
          // We check this once per block at the block boundary rather than per-sample for efficiency.
          if (!this.loopEnabled && i === 0) {
            const tapeEnd = Math.max(...this.tapeClips.map((c) => c.tapeStart + c.duration));
            if (rawTapePos >= tapeEnd) {
              this.playing = false;
              break;
            }
          }

          const tapePos = this.effectiveTapePos(rawTapePos);

          let sample = 0;
          for (const clip of this.tapeClips) {
            if (clip.muted) continue;
            const clipOffset = tapePos - clip.tapeStart;
            if (clipOffset >= 0 && clipOffset < clip.duration) {
              const srcIdx = clip.sourceStart + Math.floor(clipOffset);
              sample += (clip.samples[srcIdx] ?? 0) * clip.gain;
            }
          }
          output[i] = sample;
        }
      }

      if (this.clickAtFrame !== null) {
        for (let i = 0; i < blockSize; i++) {
          const clickIndex = blockStartFrame + i - this.clickAtFrame;
          if (clickIndex >= 0 && clickIndex < CLICK_LENGTH) {
            output[i] += CLICK_WAVEFORM[clickIndex];
          }
        }
        if (blockStartFrame + blockSize > this.clickAtFrame + CLICK_LENGTH) {
          this.clickAtFrame = null;
        }
      }
    }

    this.blockCounter += 1;
    if (this.blockCounter >= PLAYHEAD_POST_INTERVAL_BLOCKS) {
      this.blockCounter = 0;
      const rawTapePos = this.playing
        ? this.playbackTapeStart + (blockStartFrame - this.playbackAudioStart)
        : this.playbackTapeStart;
      const tapePosition = this.playing ? this.effectiveTapePos(rawTapePos) : rawTapePos;
      const message: FromProcessorMessage = { type: 'playhead', frame: blockStartFrame, tapePosition, playing: this.playing };
      this.port.postMessage(message);
    }

    return true;
  }
}

registerProcessor('tape-processor', TapeProcessor);
