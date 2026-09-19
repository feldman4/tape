// Minimal ambient declarations for the AudioWorkletGlobalScope.
// TypeScript's lib.dom.d.ts does not include these; only the subset
// actually used by src/audio/worklets/sampler-recorder-processor.ts is declared here.

declare const currentFrame: number;
declare const sampleRate: number;

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}

declare function registerProcessor(
  name: string,
  processorCtor: new (options?: unknown) => AudioWorkletProcessor,
): void;
