# Loop Pad

A browser-based 16-slot MIDI sampler, driven entirely by MIDI (notes for
record/play, CC for per-slot mixing). See [docs/manual.md](docs/manual.md)
for the full user-facing spec this implementation follows, and
[docs/front-panel.png](docs/front-panel.png) for the reference panel design.

## Running it

```sh
npm install         # from the repo root
npm run dev:loop-pad
```

Requires a real Chromium-based browser (Chrome/Edge) for Web MIDI's
permission prompt.

```sh
npm run build:loop-pad   # tsc -b && vite build
npm run lint:loop-pad    # oxlint
```

## Architecture

- [src/audio/samplerEngine.ts](src/audio/samplerEngine.ts) — main-thread
  wrapper around the `AudioContext` and the `sampler-recorder-processor`
  `AudioWorkletNode`. Recording (arm/flush/discard per slot, any subset of
  the 16 slots may record concurrently) happens in the worklet; one-shot
  playback uses per-trigger `AudioBufferSourceNode` → lowpass/highpass
  `BiquadFilterNode` chain → `StereoPannerNode` → `GainNode` graphs, since
  16 independent one-shots need no sample-accurate cross-slot mixing the
  way Tape's multi-clip lane does — reusing Tape's worklet wasn't a fit,
  so this is a purpose-built, simpler processor (see
  [src/audio/worklets/sampler-recorder-processor.ts](src/audio/worklets/sampler-recorder-processor.ts)).
- [src/midi/midiEngine.ts](src/midi/midiEngine.ts) — decodes Note On/Off,
  Control Change, and realtime Clock/Start/Stop from a single selected
  input, and can send Start/Stop to a single selected output. Simpler than
  Tape's `SyncEngine` (no audio-rate transport estimate needed here).
- [src/sampler/model.ts](src/sampler/model.ts) — `Project` (16 `Slot`s),
  each with state, recorded samples, peak envelope, and per-slot mixer
  (level/pan/LPF/HPF cutoff).
- [src/sampler/useSampler.ts](src/sampler/useSampler.ts) — the controller:
  routes MIDI events to the engine and project state, handles the 500 ms
  delete-note window (either order), routes CC to the last-triggered slot,
  and drives count-in transport interception.
- [src/sampler/session.ts](src/sampler/session.ts) +
  [src/sampler/projectCodec.ts](src/sampler/projectCodec.ts) — 10 fixed
  projects persisted to IndexedDB, encoded as a flat binary blob per
  project (mirrors Tape's `src/tape/session.ts` DB-per-app pattern).
- [src/sampler/zipStore.ts](src/sampler/zipStore.ts) — minimal store-only
  ZIP reader/writer for "Download Projects" / "Restore" (no compression
  dependency needed — project audio barely compresses anyway).
- [src/util/deviceMemory.ts](src/util/deviceMemory.ts) — remembers the last
  selected audio/MIDI device by name in `localStorage` and reconnects it
  automatically when a device with that name is available again.
- [src/ui/SamplerPage.tsx](src/ui/SamplerPage.tsx),
  [src/ui/SlotView.tsx](src/ui/SlotView.tsx),
  [src/ui/SlotRing.tsx](src/ui/SlotRing.tsx) — the 16-slot grid; each slot
  is a canvas-drawn circular waveform ring (display-only, not a control)
  plus four mini dial displays for level/pan/LPF/HPF.
- [src/ui/InputLevelMeter.tsx](src/ui/InputLevelMeter.tsx) — narrow stereo
  input meter fixed to the left edge, read each frame straight from a pair
  of `AnalyserNode`s (`SamplerEngine.inputLevelAnalysers`, split off the
  input via a `ChannelSplitterNode` independent of the mono recording path).
