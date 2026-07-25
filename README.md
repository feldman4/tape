# Tape

A browser-based multitrack tape recorder. Vite + React + TypeScript, built as
a staged implementation — see [docs/starting_plan.md](docs/starting_plan.md)
for the original design doc and [docs/stage0-progress.md](docs/stage0-progress.md)
for the staged plan and current progress.

Currently in **Stage 0**: a feasibility spike proving out the full audio
engine + MIDI sync engine on a single tape lane, before building out the
full multi-lane app.

## Running it

```sh
npm install
npm run dev
```

Requires a real Chromium-based browser (Chrome/Edge) — Web MIDI's permission
prompt isn't implemented in VS Code's Simple Browser or most embedded
webviews.

```sh
npm run build   # tsc -b && vite build
npm run lint    # oxlint
```

## Key files

### Audio engine (main thread)
- [src/audio/audioEngine.ts](src/audio/audioEngine.ts) — wraps `AudioContext` +
  the `tape-processor` `AudioWorkletNode`; owns the sample-accurate audio
  clock and input audio device selection/switching.
- [src/audio/worklets/tape-processor.ts](src/audio/worklets/tape-processor.ts) —
  `AudioWorkletProcessor` running on the audio rendering thread: record,
  playback, and click-scheduling for a single duplex tape lane. All timing is
  in absolute sample frames (`currentFrame`), never wall-clock time.
- [src/audio/audioPool.ts](src/audio/audioPool.ts) — in-memory immutable
  store of recorded audio buffers.
- [src/audio/clickWaveform.ts](src/audio/clickWaveform.ts) /
  [src/audio/latencyTest.ts](src/audio/latencyTest.ts) — loopback latency
  self-test: plays a tone burst through the output, records it back, and uses
  normalized cross-correlation to measure round-trip latency.

### MIDI sync
- [src/sync/syncEngine.ts](src/sync/syncEngine.ts) — parses MIDI Clock/
  Start/Stop, derives a smoothed tempo, converts between MIDI's
  `performance.now()` time domain and the audio sample-clock domain (via
  `AudioContext.getOutputTimestamp()`), and handles MIDI input device
  selection.
- [src/types/webmidi.d.ts](src/types/webmidi.d.ts) — ambient Web MIDI API
  types (not in TS's default `lib.dom.d.ts`).
- [src/types/audioworklet.d.ts](src/types/audioworklet.d.ts) — ambient
  `AudioWorkletGlobalScope` types (`currentFrame`, `registerProcessor`, etc.).

### Tape data model & recording
- [src/tape/model.ts](src/tape/model.ts) — minimal single-lane Tape/Clip
  types.
- [src/tape/recording.ts](src/tape/recording.ts) — finalizes a raw take into
  a `Clip`: `finalizeFreeRecording` (direct placement) and
  `finalizeSyncRecording` (resamples to an exact beat-grid length).

### UI
- [src/ui/TapePage.tsx](src/ui/TapePage.tsx) — main Stage 0 page: transport
  controls, Free/Sync mode, audio/MIDI device pickers (default to a
  connected "OP-Z" device/input if present), latency test, and readouts.
- [src/ui/renderers/TimelineRenderer.ts](src/ui/renderers/TimelineRenderer.ts) —
  Canvas drawing for the waveform and playhead.

## Gotchas worth knowing before touching audio code

- **AudioWorklet + Vite**: import worklet modules with the `?worker&url`
  suffix (e.g. `import url from './worklets/foo.ts?worker&url'`), not
  `new URL(..., import.meta.url)`. The latter copies raw, untranspiled
  TypeScript as a static asset, which the browser can't execute as a module.
- **`erasableSyntaxOnly`** is enabled in `tsconfig.app.json`, so TS
  constructor parameter-property shorthand (`constructor(private x: Foo)`)
  isn't allowed — assign fields manually in the constructor body.
- **Web MIDI in embedded browsers**: VS Code's Simple Browser (and most
  webviews) don't implement the MIDI permission prompt, so `requestMIDIAccess`
  fails there even though it works in a real Chrome window.
