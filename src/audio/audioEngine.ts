// Main-thread wrapper around the AudioContext + tape-processor AudioWorkletNode.
// Owns the sample-accurate audio clock (`currentFrame`, as reported by the
// worklet) and exposes a small message-based API. No UI/React code runs here,
// and no audio-thread code runs on the main thread - this is the boundary
// between them.

// `?worker&url` tells Vite to bundle+transpile this TS module (and its
// imports) into a standalone JS chunk and give us its URL, rather than
// copying the raw .ts source as a static asset (which the browser can't
// execute). This is the standard Vite technique for AudioWorklet modules.
import tapeProcessorUrl from './worklets/tape-processor.ts?worker&url';
import type { Clip } from '../tape/model';
import type { AudioPool } from './audioPool';

// Shape sent to the worklet (must match WorkletClip in tape-processor.ts)
export interface WorkletClip {
  samples: Float32Array;
  tapeStart: number;
  duration: number;
  sourceStart: number;
  gain: number;
  muted: boolean;
}

type FromProcessorMessage =
  | { type: 'recorded'; samples: Float32Array; startFrame: number }
  | { type: 'playhead'; frame: number; tapePosition: number; playing: boolean };

export interface PlayheadInfo {
  frame: number;
  tapePosition: number;
  playing: boolean;
}

export interface LoopOptions {
  loopIn: number;
  loopOut: number;
  loopEnabled: boolean;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private currentDeviceId: string | null = null;

  private playheadListeners = new Set<(info: PlayheadInfo) => void>();
  private pendingRecording: ((result: { samples: Float32Array; startFrame: number }) => void) | null = null;

  get audioContext(): AudioContext {
    if (!this.ctx) throw new Error('AudioEngine not initialized: call init() first');
    return this.ctx;
  }

  get sampleRate(): number {
    return this.audioContext.sampleRate;
  }

  get inputDeviceId(): string | null {
    return this.currentDeviceId;
  }

  async init(deviceId?: string): Promise<void> {
    this.stream = await this.acquireStream(deviceId);
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    await this.ctx.audioWorklet.addModule(tapeProcessorUrl);

    this.node = new AudioWorkletNode(this.ctx, 'tape-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'discrete',
    });
    this.node.port.onmessage = (event: MessageEvent<FromProcessorMessage>) => this.handleMessage(event.data);

    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.source.connect(this.node);
    this.node.connect(this.ctx.destination);
  }

  /** Lists available audio input devices. Labels are only populated once mic permission has been granted. */
  async listInputDevices(): Promise<MediaDeviceInfo[]> {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((device) => device.kind === 'audioinput');
  }

  /** Switches the live input device without tearing down the AudioContext/worklet. */
  async setInputDevice(deviceId: string): Promise<void> {
    if (!this.ctx || !this.node) throw new Error('AudioEngine not initialized: call init() first');
    const newStream = await this.acquireStream(deviceId);

    this.source?.disconnect();
    for (const track of this.stream?.getTracks() ?? []) track.stop();

    this.stream = newStream;
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.source.connect(this.node);
  }

  private async acquireStream(deviceId?: string): Promise<MediaStream> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    this.currentDeviceId = stream.getAudioTracks()[0]?.getSettings().deviceId ?? deviceId ?? null;
    return stream;
  }

  private handleMessage(msg: FromProcessorMessage): void {
    switch (msg.type) {
      case 'recorded':
        this.pendingRecording?.({ samples: msg.samples, startFrame: msg.startFrame });
        this.pendingRecording = null;
        break;
      case 'playhead':
        for (const listener of this.playheadListeners) {
          listener({ frame: msg.frame, tapePosition: msg.tapePosition, playing: msg.playing });
        }
        break;
    }
  }

  onPlayhead(listener: (info: PlayheadInfo) => void): () => void {
    this.playheadListeners.add(listener);
    return () => this.playheadListeners.delete(listener);
  }

  /** Converts a "seconds from now" offset into an absolute sample frame, for scheduling. */
  frameForTimeFromNow(secondsFromNow = 0): number {
    return Math.round((this.audioContext.currentTime + secondsFromNow) * this.sampleRate);
  }

  startRecording(): void {
    this.node!.port.postMessage({ type: 'record-start' });
  }

  stopRecording(): Promise<{ samples: Float32Array; startFrame: number }> {
    return new Promise((resolve) => {
      this.pendingRecording = resolve;
      this.node!.port.postMessage({ type: 'record-stop' });
    });
  }

  /**
   * Sends all tape clips to the worklet (structured clone — main thread retains originals in pool).
   * Must be called whenever clips change before the next play().
   */
  loadTape(clips: Clip[], pool: AudioPool): void {
    const workletClips: WorkletClip[] = [];
    for (const clip of clips) {
      if (clip.muted) continue; // muted clips sent with muted=true so worklet skips them
      const samples = pool.get(clip.audioBufferId);
      if (!samples) continue;
      workletClips.push({
        samples,
        tapeStart: clip.tapeStart,
        duration: clip.duration,
        sourceStart: clip.sourceStart,
        gain: clip.gain,
        muted: clip.muted,
      });
    }
    // Structured clone (no transfer list) so pool retains original Float32Arrays for rendering.
    this.node!.port.postMessage({ type: 'set-tape', clips: workletClips });
  }

  /**
   * Starts playback from the given tape position (in samples).
   * Schedules playback to begin ~50ms from now for sample-accurate start.
   */
  play(tapePosition: number, loop: LoopOptions): number {
    const atAudioFrame = this.frameForTimeFromNow(0.05);
    this.node!.port.postMessage({
      type: 'play',
      tapeStart: tapePosition,
      atAudioFrame,
      loopIn: loop.loopIn,
      loopOut: loop.loopOut,
      loopEnabled: loop.loopEnabled,
    });
    return atAudioFrame;
  }

  stopPlayback(): void {
    this.node!.port.postMessage({ type: 'stop-playback' });
  }

  /** Updates loop region during active playback without restarting. */
  setLoop(loop: LoopOptions): void {
    this.node!.port.postMessage({
      type: 'set-loop',
      loopIn: loop.loopIn,
      loopOut: loop.loopOut,
      loopEnabled: loop.loopEnabled,
    });
  }

  /** Schedules a short click on the output ~secondsFromNow later; returns the frame it will play at. */
  scheduleClick(secondsFromNow = 0.05): number {
    const atFrame = this.frameForTimeFromNow(secondsFromNow);
    this.node!.port.postMessage({ type: 'click', atFrame });
    return atFrame;
  }
}
