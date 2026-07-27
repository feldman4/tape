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
  pan: number;   // -1 (full L) .. 0 (centre) .. +1 (full R)
  muted: boolean;
}

type ToProcessorMessage =
  | { type: 'record-start' }
  | { type: 'record-stop' }
  /** Flush recorded chunks to main thread and reset buffer, but keep recording. */
  | { type: 'record-rotate' }
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

  // Gain ramp — eliminates start/stop clicks.
  // ~5 ms at 44100 Hz; inaudible as a fade but removes the transient.
  private static readonly FADE_SAMPLES = 220;
  private fadeGain = 1;
  private fadeDir = 0; // 1 = fading in, -1 = fading out, 0 = stable

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
      case 'record-rotate':
        // Flush current buffer to main thread, reset, keep recording=true.
        this.flushRecording();
        this.recordStartFrame = currentFrame;
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
        this.fadeGain = 0;
        this.fadeDir = 1;
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
        if (this.playing) {
          this.fadeDir = -1;
        }
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
    const input  = inputs[0]?.[0];
    const outL   = outputs[0]?.[0]; // left  channel
    const outR   = outputs[0]?.[1]; // right channel
    const blockStartFrame = currentFrame;

    if (this.recording && input) {
      this.recordedChunks.push(input.slice());
    }

    if (outL) outL.fill(0);
    if (outR) outR.fill(0);

    const blockSize = outL?.length ?? outR?.length ?? 0;

    if (blockSize > 0 && this.playing && this.tapeClips.length > 0) {
      for (let i = 0; i < blockSize; i++) {
        const rawTapePos = this.playbackTapeStart + (blockStartFrame + i - this.playbackAudioStart);

        // Stop playback if we’ve gone past all clip content and loop is off.
        if (!this.loopEnabled && i === 0) {
          const tapeEnd = Math.max(...this.tapeClips.map((c) => c.tapeStart + c.duration));
          if (rawTapePos >= tapeEnd) {
            this.playing = false;
            break;
          }
        }

        const tapePos = this.effectiveTapePos(rawTapePos);

        for (const clip of this.tapeClips) {
          if (clip.muted) continue;
          const clipOffset = tapePos - clip.tapeStart;
          if (clipOffset >= 0 && clipOffset < clip.duration) {
            const srcIdx = clip.sourceStart + Math.floor(clipOffset);
            const raw = (clip.samples[srcIdx] ?? 0) * clip.gain;
            // Constant-power pan: angle in [0, π/2]
            const angle = (clip.pan + 1) * 0.7853981633974483; // (pan+1)*π/4
            if (outL) outL[i] += raw * Math.cos(angle);
            if (outR) outR[i] += raw * Math.sin(angle);
          }
        }
      }
    }

    // Click (latency test) — plays centred on both channels.
    if (this.clickAtFrame !== null && blockSize > 0) {
      for (let i = 0; i < blockSize; i++) {
        const clickIndex = blockStartFrame + i - this.clickAtFrame;
        if (clickIndex >= 0 && clickIndex < CLICK_LENGTH) {
          const clickSample = CLICK_WAVEFORM[clickIndex]!;
          if (outL) outL[i] += clickSample;
          if (outR) outR[i] += clickSample;
        }
      }
      if (blockStartFrame + blockSize > this.clickAtFrame + CLICK_LENGTH) {
        this.clickAtFrame = null;
      }
    }

    // Apply fade-in / fade-out envelope.
    const fadeStep = 1 / TapeProcessor.FADE_SAMPLES;
    if (this.fadeDir !== 0 && blockSize > 0) {
      for (let i = 0; i < blockSize; i++) {
        if (outL) outL[i] *= this.fadeGain;
        if (outR) outR[i] *= this.fadeGain;
        if (this.fadeDir === 1) {
          this.fadeGain += fadeStep;
          if (this.fadeGain >= 1) { this.fadeGain = 1; this.fadeDir = 0; }
        } else {
          this.fadeGain -= fadeStep;
          if (this.fadeGain <= 0) {
            this.fadeGain = 0;
            this.fadeDir = 0;
            this.playing = false;
            for (let j = i + 1; j < blockSize; j++) {
              if (outL) outL[j] = 0;
              if (outR) outR[j] = 0;
            }
            break;
          }
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
