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
import type { Lane } from '../tape/model';
import type { AudioPool } from './audioPool';

// Shape sent to the worklet (must match WorkletClip in tape-processor.ts)
export interface WorkletClip {
  samples: Float32Array;
  tapeStart: number;
  duration: number;
  sourceStart: number;
  gain: number;
  pan: number;
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
  private currentOutputDeviceId: string = '';  // '' = system default

  private playheadListeners = new Set<(info: PlayheadInfo) => void>();
  private pendingRecordingQueue: ((result: { samples: Float32Array; startFrame: number }) => void)[] = [];

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

  get outputDeviceId(): string {
    return this.currentOutputDeviceId;
  }

  /** AudioContext output latency in seconds (time from render to speaker output). */
  get outputLatencySecs(): number {
    return this.ctx?.outputLatency ?? 0;
  }

  /** Lists available audio output devices. Labels are only populated once mic permission has been granted. */
  async listOutputDevices(): Promise<MediaDeviceInfo[]> {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((device) => device.kind === 'audiooutput');
  }

  /** Routes AudioContext output to the given device ('' = system default). */
  async setOutputDevice(sinkId: string): Promise<void> {
    if (!this.ctx) throw new Error('AudioEngine not initialized: call init() first');
    // setSinkId is defined in modern browsers; cast for TypeScript compatibility.
    await (this.ctx as AudioContext & { setSinkId(id: string): Promise<void> }).setSinkId(sinkId);
    this.currentOutputDeviceId = sinkId;
  }

  async init(deviceId?: string): Promise<void> {
    this.stream = await this.acquireStream(deviceId);
    this.ctx = new AudioContext({ latencyHint: 0 });
    await this.ctx.audioWorklet.addModule(tapeProcessorUrl);

    this.node = new AudioWorkletNode(this.ctx, 'tape-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,           // mono input (mic)
      channelCountMode: 'explicit',
      channelInterpretation: 'discrete',
      outputChannelCount: [2],   // stereo output for panning
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
        this.pendingRecordingQueue.shift()?.({ samples: msg.samples, startFrame: msg.startFrame });
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

  /** Sets the gain applied to microphone input samples captured by the worklet. */
  setRecordingGain(gain: number): void {
    this.node!.port.postMessage({ type: 'set-recording-gain', gain });
  }

  stopRecording(): Promise<{ samples: Float32Array; startFrame: number }> {
    return new Promise((resolve) => {
      this.pendingRecordingQueue.push(resolve);
      this.node!.port.postMessage({ type: 'record-stop' });
    });
  }

  /**
   * Atomically flushes the current recording buffer to the main thread and resets
   * it, WITHOUT stopping recording.  Used for per-loop-pass overdub in free mode.
   */
  rotateRecording(): Promise<{ samples: Float32Array; startFrame: number }> {
    return new Promise((resolve) => {
      this.pendingRecordingQueue.push(resolve);
      this.node!.port.postMessage({ type: 'record-rotate' });
    });
  }

  /**
   * Sends all tape lanes to the worklet, applying per-lane gain, pan, and mute.
   * Must be called whenever clips or lane settings change before the next play().
   */
  loadTape(lanes: Lane[], pool: AudioPool): void {
    const workletClips: WorkletClip[] = [];
    for (const lane of lanes) {
      if (lane.muted) continue;
      for (const clip of lane.clips) {
        if (clip.muted) continue;
        const samples = pool.get(clip.audioBufferId);
        if (!samples) continue;
        workletClips.push({
          samples,
          tapeStart:   clip.tapeStart,
          duration:    clip.duration,
          sourceStart: clip.sourceStart,
          gain:        clip.gain * lane.gain,
          pan:         lane.pan,
          muted:       false,
        });
      }
    }
    // Structured clone so pool retains original Float32Arrays for rendering.
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
