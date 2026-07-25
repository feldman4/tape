// AudioWorkletProcessor for the Stage 0 spike: a single duplex tape
// lane that can record its input and, independently, play back one
// loaded clip. Runs entirely on the audio rendering thread - no DOM,
// no React, no imports beyond pure computation helpers.
//
// All timing is expressed in absolute sample frames (`currentFrame`),
// never wall-clock time, so playback/record decisions are sample-accurate.

import { CLICK_LENGTH, createClickWaveform } from '../clickWaveform';

type ToProcessorMessage =
  | { type: 'record-start' }
  | { type: 'record-stop' }
  | { type: 'load-clip'; samples: Float32Array; startFrame: number }
  | { type: 'stop-playback' }
  | { type: 'click'; atFrame: number };

type FromProcessorMessage =
  | { type: 'recorded'; samples: Float32Array; startFrame: number }
  | { type: 'playhead'; frame: number; playing: boolean };

const CLICK_WAVEFORM = createClickWaveform();
const PLAYHEAD_POST_INTERVAL_BLOCKS = 16; // throttle main-thread messages (~46ms @128/44.1kHz)

class TapeProcessor extends AudioWorkletProcessor {
  private recording = false;
  private recordedChunks: Float32Array[] = [];
  private recordStartFrame = 0;

  private clip: Float32Array | null = null;
  private clipStartFrame = 0;
  private playing = false;

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
      case 'load-clip':
        this.clip = msg.samples;
        this.clipStartFrame = msg.startFrame;
        this.playing = true;
        break;
      case 'stop-playback':
        this.playing = false;
        this.clip = null;
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
    const message: FromProcessorMessage = {
      type: 'recorded',
      samples: merged,
      startFrame: this.recordStartFrame,
    };
    this.port.postMessage(message, [merged.buffer]);
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

      if (this.playing && this.clip) {
        for (let i = 0; i < blockSize; i++) {
          const clipIndex = blockStartFrame + i - this.clipStartFrame;
          if (clipIndex < 0) continue;
          if (clipIndex >= this.clip.length) {
            this.playing = false;
            break;
          }
          output[i] = this.clip[clipIndex];
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
      const message: FromProcessorMessage = { type: 'playhead', frame: blockStartFrame, playing: this.playing };
      this.port.postMessage(message);
    }

    return true;
  }
}

registerProcessor('tape-processor', TapeProcessor);
