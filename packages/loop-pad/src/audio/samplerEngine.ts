// Main-thread wrapper around the AudioContext + sampler-recorder-processor
// AudioWorkletNode. Recording is delegated to the worklet (arm/flush/discard
// per slot, arbitrary slots may record concurrently); one-shot playback uses
// plain AudioBufferSourceNode + BiquadFilter + StereoPannerNode + GainNode
// chains built per trigger, since 16 independent one-shots need no
// sample-accurate cross-slot mixing the way Tape's multi-clip lane does.

import recorderUrl from './worklets/sampler-recorder-processor.ts?worker&url';
import type { StereoSamples } from '../sampler/model';

type FromProcessorMessage =
  | { type: 'recorded'; slot: number; samples: StereoSamples }
  | { type: 'progress'; slot: number; peak: number };

export interface SlotMixerValues {
  level: number;     // 0..1
  pan: number;       // -1..1
  lpfCutoff: number; // 0..1 (1 = fully open)
  hpfCutoff: number; // 0..1 (0 = fully open)
}

interface Voice {
  source: AudioBufferSourceNode;
  gain: GainNode;
  tailGain: GainNode;
  outputSplitter: ChannelSplitterNode;
  panner: StereoPannerNode;
  lpf: BiquadFilterNode[];
  hpf: BiquadFilterNode[];
}

const LPF_MIN_HZ = 200;
const LPF_MAX_HZ = 20000;
const HPF_MIN_HZ = 20;
const HPF_MAX_HZ = 2000;

/** Maps a 0..1 LPF knob value to a cutoff frequency (log scale, 1 = fully open). */
export function lpfFrequency(cutoff01: number): number {
  const t = Math.max(0, Math.min(1, cutoff01));
  return LPF_MIN_HZ * Math.pow(LPF_MAX_HZ / LPF_MIN_HZ, t);
}

/** Maps a 0..1 HPF knob value to a cutoff frequency (log scale, 0 = fully open). */
export function hpfFrequency(cutoff01: number): number {
  const t = Math.max(0, Math.min(1, cutoff01));
  return HPF_MIN_HZ * Math.pow(HPF_MAX_HZ / HPF_MIN_HZ, t);
}

export class SamplerEngine {
  private ctx: AudioContext | null = null;
  private recorderNode: AudioWorkletNode | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private inputSplitter: ChannelSplitterNode | null = null;
  private inputPairMerger: ChannelMergerNode | null = null;
  private silentGain: GainNode | null = null;
  private outputBus: ChannelMergerNode | null = null;
  private currentDeviceId: string | null = null;
  private inputChannelCount = 1;
  private inputChannelPairStart = 0;
  private currentOutputDeviceId = ''; // '' = system default
  private outputChannelPairStart = 0;
  private outputChannelCount = 2;

  private buffers = new Map<number, AudioBuffer>();
  private voices = new Map<number, Voice>();
  private filterSlopeStages: 1 | 2 = 2;
  private levelSplitter: ChannelSplitterNode | null = null;
  private levelAnalyserL: AnalyserNode | null = null;
  private levelAnalyserR: AnalyserNode | null = null;
  private countInClicks = new Set<OscillatorNode>();

  private progressListeners = new Set<(slot: number, peak: number) => void>();
  private endedListeners = new Set<(slot: number) => void>();
  private pendingRecordings = new Map<number, (samples: StereoSamples) => void>();

  get audioContext(): AudioContext {
    if (!this.ctx) throw new Error('SamplerEngine not initialized: call init() first');
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

  get inputChannels(): number {
    return this.inputChannelCount;
  }

  get selectedInputChannelPairStart(): number {
    return this.inputChannelPairStart;
  }

  get outputChannels(): number {
    return this.outputChannelCount;
  }

  get selectedOutputChannelPairStart(): number {
    return this.outputChannelPairStart;
  }

  setFilterSlope(stages: 1 | 2): void {
    this.filterSlopeStages = stages;
  }

  /** L/R analysers for the input level meter, or null before init(). */
  get inputLevelAnalysers(): { left: AnalyserNode; right: AnalyserNode } | null {
    return this.levelAnalyserL && this.levelAnalyserR ? { left: this.levelAnalyserL, right: this.levelAnalyserR } : null;
  }

  async init(deviceId?: string): Promise<void> {
    this.stream = await this.acquireStream(deviceId);
    this.ctx = new AudioContext({ latencyHint: 0 });
    await this.ctx.audioWorklet.addModule(recorderUrl);

    this.recorderNode = new AudioWorkletNode(this.ctx, 'sampler-recorder-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 2,
      channelCountMode: 'explicit',
      channelInterpretation: 'discrete',
    });
    this.recorderNode.port.onmessage = (event: MessageEvent<FromProcessorMessage>) => this.handleMessage(event.data);

    // Stereo level-metering tap for the selected stereo recording pair.
    this.levelSplitter = this.ctx.createChannelSplitter(2);
    this.levelAnalyserL = this.ctx.createAnalyser();
    this.levelAnalyserL.fftSize = 256;
    this.levelSplitter.connect(this.levelAnalyserL, 0);
    this.levelAnalyserR = this.ctx.createAnalyser();
    this.levelAnalyserR.fftSize = 256;
    this.levelSplitter.connect(this.levelAnalyserR, 1);

    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.configureInputRouting();

    this.outputChannelCount = Math.max(2, this.ctx.destination.maxChannelCount);
    this.ctx.destination.channelCount = this.outputChannelCount;
    this.outputBus = this.ctx.createChannelMerger(this.outputChannelCount);
    this.outputBus.connect(this.ctx.destination);

    // The recorder node produces no audible output; route through a silent
    // gain to the output bus so the graph keeps pulling it for processing.
    this.silentGain = this.ctx.createGain();
    this.silentGain.gain.value = 0;
    this.recorderNode.connect(this.silentGain);
    this.silentGain.connect(this.outputBus, 0, 0);
  }

  async listInputDevices(): Promise<MediaDeviceInfo[]> {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((device) => device.kind === 'audioinput');
  }

  async listOutputDevices(): Promise<MediaDeviceInfo[]> {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((device) => device.kind === 'audiooutput');
  }

  async setInputDevice(deviceId: string): Promise<void> {
    if (!this.ctx || !this.recorderNode) throw new Error('SamplerEngine not initialized: call init() first');
    this.source?.disconnect();
    for (const track of this.stream?.getTracks() ?? []) track.stop();

    this.stream = await this.acquireStream(deviceId);
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.configureInputRouting();
  }

  setInputChannelPair(start: number): void {
    this.inputChannelPairStart = Math.max(0, Math.min(this.inputChannelCount - 2, start));
    this.connectInputChannelPair();
  }

  async setOutputDevice(sinkId: string): Promise<void> {
    if (!this.ctx) throw new Error('SamplerEngine not initialized: call init() first');
    await (this.ctx as AudioContext & { setSinkId(id: string): Promise<void> }).setSinkId(sinkId);
    this.currentOutputDeviceId = sinkId;
  }

  setOutputChannelPair(start: number): void {
    const maximumStart = Math.max(0, this.outputChannelCount - 2);
    this.outputChannelPairStart = Math.max(0, Math.min(maximumStart, start));
    for (const voice of this.voices.values()) this.connectVoiceToOutput(voice);
  }

  private async acquireStream(deviceId?: string): Promise<MediaStream> {
    const constraints = {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      channelCount: { ideal: 32 },
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    };
    let stream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
    const track = stream.getAudioTracks()[0];
    const maxChannels = track?.getCapabilities().channelCount?.max;
    const activeChannels = track?.getSettings().channelCount ?? 1;

    // Chrome may satisfy an ideal multichannel request with stereo. Reopen at
    // the device's reported maximum so every physical input pair is routable.
    if (maxChannels && maxChannels > activeChannels) {
      track?.stop();
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { ...constraints, channelCount: { exact: maxChannels } },
      });
    }
    this.currentDeviceId = stream.getAudioTracks()[0]?.getSettings().deviceId ?? deviceId ?? null;
    return stream;
  }

  private configureInputRouting(): void {
    const channelCount = this.stream?.getAudioTracks()[0]?.getSettings().channelCount ?? 1;
    // A mono input still needs the default 1-2 pair; Web Audio upmixes that
    // single source channel into the pair while multichannel devices retain
    // all their physical channel pairs.
    this.inputChannelCount = Math.max(2, channelCount);
    this.inputChannelPairStart = Math.min(this.inputChannelPairStart, Math.max(0, this.inputChannelCount - 2));
    this.inputSplitter?.disconnect();
    this.inputSplitter = this.audioContext.createChannelSplitter(this.inputChannelCount);
    this.inputPairMerger?.disconnect();
    this.inputPairMerger = this.audioContext.createChannelMerger(2);
    this.source!.connect(this.inputSplitter);
    this.inputPairMerger.connect(this.recorderNode!);
    this.inputPairMerger.connect(this.levelSplitter!);
    this.connectInputChannelPair();
  }

  private connectInputChannelPair(): void {
    if (!this.inputSplitter || !this.inputPairMerger) return;
    try {
      this.inputSplitter.disconnect(this.inputPairMerger);
    } catch {
      // The initial pair connection has no existing route to remove.
    }
    this.inputSplitter.connect(this.inputPairMerger, this.inputChannelPairStart, 0);
    this.inputSplitter.connect(this.inputPairMerger, this.inputChannelPairStart + 1, 1);
  }

  private handleMessage(msg: FromProcessorMessage): void {
    if (msg.type === 'recorded') {
      this.pendingRecordings.get(msg.slot)?.(msg.samples);
      this.pendingRecordings.delete(msg.slot);
    } else {
      for (const listener of this.progressListeners) listener(msg.slot, msg.peak);
    }
  }

  onRecordingProgress(listener: (slot: number, peak: number) => void): () => void {
    this.progressListeners.add(listener);
    return () => this.progressListeners.delete(listener);
  }

  onPlaybackEnded(listener: (slot: number) => void): () => void {
    this.endedListeners.add(listener);
    return () => this.endedListeners.delete(listener);
  }

  startRecording(slot: number): void {
    this.recorderNode!.port.postMessage({ type: 'arm', slot });
  }

  stopRecording(slot: number): Promise<StereoSamples> {
    return new Promise((resolve) => {
      this.pendingRecordings.set(slot, resolve);
      this.recorderNode!.port.postMessage({ type: 'flush', slot });
    });
  }

  /** Discards an in-progress recording (e.g. the slot was deleted mid-take). */
  cancelRecording(slot: number): void {
    this.pendingRecordings.delete(slot);
    this.recorderNode!.port.postMessage({ type: 'discard', slot });
  }

  /** Loads a recorded stereo buffer into an AudioBuffer ready for playback. */
  loadSlotBuffer(slot: number, samples: StereoSamples): void {
    const buffer = this.audioContext.createBuffer(2, Math.max(1, samples.left.length), this.sampleRate);
    buffer.copyToChannel(samples.left as Float32Array<ArrayBuffer>, 0);
    buffer.copyToChannel(samples.right as Float32Array<ArrayBuffer>, 1);
    this.buffers.set(slot, buffer);
  }

  clearSlotBuffer(slot: number): void {
    this.stop(slot);
    this.buffers.delete(slot);
  }

  hasBuffer(slot: number): boolean {
    return this.buffers.has(slot);
  }

  /** Starts (or restarts, if already playing) one-shot playback for a slot. */
  play(slot: number, mixer: SlotMixerValues, tailMs: number): void {
    const buffer = this.buffers.get(slot);
    if (!buffer) return;
    this.stopVoice(slot);

    const ctx = this.audioContext;
    const source = ctx.createBufferSource();
    source.buffer = buffer;

    const lpf: BiquadFilterNode[] = [];
    const hpf: BiquadFilterNode[] = [];
    for (let i = 0; i < this.filterSlopeStages; i++) {
      const node = ctx.createBiquadFilter();
      node.type = 'lowpass';
      node.frequency.value = lpfFrequency(mixer.lpfCutoff);
      lpf.push(node);
    }
    for (let i = 0; i < this.filterSlopeStages; i++) {
      const node = ctx.createBiquadFilter();
      node.type = 'highpass';
      node.frequency.value = hpfFrequency(mixer.hpfCutoff);
      hpf.push(node);
    }
    const panner = ctx.createStereoPanner();
    panner.pan.value = mixer.pan;
    const gain = ctx.createGain();
    gain.gain.value = mixer.level;
    const tailGain = ctx.createGain();
    const tailSecs = Math.min(buffer.duration, Math.max(0, tailMs) / 1000);
    if (tailSecs > 0) {
      tailGain.gain.setValueAtTime(1, ctx.currentTime);
      tailGain.gain.setValueAtTime(1, ctx.currentTime + buffer.duration - tailSecs);
      tailGain.gain.linearRampToValueAtTime(0, ctx.currentTime + buffer.duration);
    }
    const outputSplitter = ctx.createChannelSplitter(2);

    const chain: AudioNode[] = [source, ...lpf, ...hpf, panner, gain, tailGain];
    for (let i = 0; i < chain.length - 1; i++) chain[i]!.connect(chain[i + 1]!);
    tailGain.connect(outputSplitter);
    this.connectVoiceToOutput({ source, gain, tailGain, outputSplitter, panner, lpf, hpf });

    source.onended = () => {
      this.voices.delete(slot);
      for (const listener of this.endedListeners) listener(slot);
    };
    source.start();
    this.voices.set(slot, { source, gain, tailGain, outputSplitter, panner, lpf, hpf });
  }

  /** Stops playback for a slot; a no-op if it isn't currently playing. */
  stop(slot: number): void {
    this.stopVoice(slot);
  }

  private stopVoice(slot: number): void {
    const voice = this.voices.get(slot);
    if (!voice) return;
    voice.source.onended = null;
    try {
      voice.source.stop();
    } catch {
      // already stopped
    }
    voice.outputSplitter.disconnect();
    this.voices.delete(slot);
  }

  private connectVoiceToOutput(voice: Voice): void {
    voice.outputSplitter.disconnect();
    voice.outputSplitter.connect(this.outputBus!, 0, this.outputChannelPairStart);
    voice.outputSplitter.connect(this.outputBus!, 1, this.outputChannelPairStart + 1);
  }

  isPlaying(slot: number): boolean {
    return this.voices.has(slot);
  }

  /** Live-updates level/pan/filter cutoffs for a currently playing voice. */
  updateMixer(slot: number, mixer: SlotMixerValues): void {
    const voice = this.voices.get(slot);
    if (!voice) return;
    voice.gain.gain.value = mixer.level;
    voice.panner.pan.value = mixer.pan;
    for (const node of voice.lpf) node.frequency.value = lpfFrequency(mixer.lpfCutoff);
    for (const node of voice.hpf) node.frequency.value = hpfFrequency(mixer.hpfCutoff);
  }

  /** Plays one audible metronome click per count-in beat on the selected output pair. */
  playCountInClicks(beats: number, beatDurationSecs: number): void {
    this.stopCountInClicks();
    const ctx = this.audioContext;
    const startAt = ctx.currentTime + 0.015;
    for (let beat = 0; beat < beats; beat++) {
      const oscillator = ctx.createOscillator();
      oscillator.type = 'square';
      oscillator.frequency.value = beat === 0 ? 1760 : 1320;
      const gain = ctx.createGain();
      const clickAt = startAt + beat * beatDurationSecs;
      gain.gain.setValueAtTime(0.0001, clickAt);
      gain.gain.exponentialRampToValueAtTime(beat === 0 ? 0.22 : 0.15, clickAt + 0.002);
      gain.gain.exponentialRampToValueAtTime(0.0001, clickAt + 0.045);
      oscillator.connect(gain);
      gain.connect(this.outputBus!, 0, this.outputChannelPairStart);
      gain.connect(this.outputBus!, 0, this.outputChannelPairStart + 1);
      oscillator.onended = () => {
        this.countInClicks.delete(oscillator);
        oscillator.disconnect();
        gain.disconnect();
      };
      oscillator.start(clickAt);
      oscillator.stop(clickAt + 0.05);
      this.countInClicks.add(oscillator);
    }
  }

  stopCountInClicks(): void {
    for (const oscillator of this.countInClicks) {
      oscillator.onended = null;
      try {
        oscillator.stop();
      } catch {
        // The click has already ended.
      }
      oscillator.disconnect();
    }
    this.countInClicks.clear();
  }

  async dispose(): Promise<void> {
    for (const slot of Array.from(this.voices.keys())) this.stopVoice(slot);
    this.stopCountInClicks();
    this.recorderNode?.port.close();
    this.recorderNode?.disconnect();
    this.source?.disconnect();
    this.inputSplitter?.disconnect();
    this.inputPairMerger?.disconnect();
    this.silentGain?.disconnect();
    this.outputBus?.disconnect();
    this.levelSplitter?.disconnect();
    this.levelAnalyserL?.disconnect();
    this.levelAnalyserR?.disconnect();
    for (const track of this.stream?.getTracks() ?? []) track.stop();

    const context = this.ctx;
    this.recorderNode = null;
    this.source = null;
    this.inputSplitter = null;
    this.inputPairMerger = null;
    this.silentGain = null;
    this.outputBus = null;
    this.levelSplitter = null;
    this.levelAnalyserL = null;
    this.levelAnalyserR = null;
    this.stream = null;
    this.ctx = null;
    this.currentDeviceId = null;
    this.inputChannelCount = 1;
    this.inputChannelPairStart = 0;
    this.currentOutputDeviceId = '';
    this.outputChannelPairStart = 0;
    this.outputChannelCount = 2;
    this.buffers.clear();
    this.voices.clear();
    this.progressListeners.clear();
    this.endedListeners.clear();
    this.pendingRecordings.clear();

    if (context && context.state !== 'closed') await context.close();
  }
}
