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

type FromProcessorMessage =
  | { type: 'recorded'; samples: Float32Array; startFrame: number }
  | { type: 'playhead'; frame: number; playing: boolean };

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private currentDeviceId: string | null = null;

  private playheadListeners = new Set<(frame: number, playing: boolean) => void>();
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
        for (const listener of this.playheadListeners) listener(msg.frame, msg.playing);
        break;
    }
  }

  onPlayhead(listener: (frame: number, playing: boolean) => void): () => void {
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

  /** Loads and plays a clip; startFrame is the absolute frame at which sample 0 should sound. */
  playClip(samples: Float32Array, startFrame: number): void {
    const copy = samples.slice();
    this.node!.port.postMessage({ type: 'load-clip', samples: copy, startFrame }, [copy.buffer]);
  }

  stopPlayback(): void {
    this.node!.port.postMessage({ type: 'stop-playback' });
  }

  /** Schedules a short click on the output ~secondsFromNow later; returns the frame it will play at. */
  scheduleClick(secondsFromNow = 0.05): number {
    const atFrame = this.frameForTimeFromNow(secondsFromNow);
    this.node!.port.postMessage({ type: 'click', atFrame });
    return atFrame;
  }
}
