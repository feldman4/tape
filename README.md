# Tape

A browser-based multitrack tape recorder. Vite + React + TypeScript, built as
a staged implementation. Start with the [user manual](docs/user_manual.md),
then use the [architecture summary](docs/architecture_summary_2026-08-02.md)
for the current technical shape and deployment critique.

Tape currently provides a 4-lane recorder with audio engine, MIDI sync, OP-Z
hardware control, mixer, and session persistence.
See the [user manual](docs/user_manual.md) for the active workflow and the
[architecture summary](docs/architecture_summary_2026-08-02.md) for current
implementation status and constraints.

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

## Hardware validation (OP-Z)

Hardware validation uses a real OP-Z connected via USB (class-compliant audio
+ MIDI). The workflow is automated end-to-end after a one-time browser-
permission setup.

```sh
npm run dev                    # in one terminal, dev server must stay running
npm run test:hardware:setup    # one-time: grants mic/MIDI permission into a
                                # persistent Chrome profile; click 'Enable Audio
                                # + MIDI', accept both prompts, then Ctrl+C
npm run test:hardware          # unattended thereafter: latency + Free-mode +
                                # Sync-mode checks, driven entirely by the OP-Z
```

Current status: short takes pass; a multi-minute drift check is still open.

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
  [src/audio/latencyTest.ts](src/audio/latencyTest.ts) - loopback latency
  self-test: plays a tone burst through the output, records it back, and uses
  normalized cross-correlation to measure round-trip latency.
- [src/audio/onsetDetect.ts](src/audio/onsetDetect.ts) - threshold/RMS-based
  onset detection, used to measure note-to-sound latency against an OP-Z
  percussion hit (its waveform isn't known in advance, unlike the internal
  loopback click).

### MIDI sync
- [src/sync/syncEngine.ts](src/sync/syncEngine.ts) - parses MIDI Clock/
  Start/Stop, derives a smoothed tempo, converts between MIDI's
  `performance.now()` time domain and the audio sample-clock domain (via
  `AudioContext.getOutputTimestamp()`), and handles MIDI input/output device
  selection. Also sends MIDI: `sendNoteOn`/`sendNoteOff` (trigger the OP-Z's
  channel-1 percussion track) and `sendStart`/`sendStop` (drive the OP-Z's
  own transport so it emits MIDI Clock back for Sync-mode tests).
- [src/types/webmidi.d.ts](src/types/webmidi.d.ts) — ambient Web MIDI API
  types (not in TS's default `lib.dom.d.ts`).
- [src/types/audioworklet.d.ts](src/types/audioworklet.d.ts) — ambient
  `AudioWorkletGlobalScope` types (`currentFrame`, `registerProcessor`, etc.).

### Tape data model & recording
- [src/tape/model.ts](src/tape/model.ts) — 4-lane `Tape` / `Lane` / `Clip`
  types. Lanes carry `clips`, `muted`, `gain`, and `pan`.
- [src/tape/session.ts](src/tape/session.ts) — IndexedDB save/load for named
  sessions. Persists all 4 lanes (clips + audio buffers), loop region, BPM,
  playhead, active lane, per-lane mute/gain/pan, and the current Free/Sync
  mode and Snap toggle.
- [src/tape/recording.ts](src/tape/recording.ts) — finalizes a raw take into
  a `Clip`: `finalizeFreeRecording` places directly, `finalizeLoopRecording`
  handles overdubs within loop boundaries.

### UI
- [src/ui/TapePage.tsx](src/ui/TapePage.tsx) - main UI with four tabs:
  - **TAPE**: 4-lane timeline canvas (620 px wide, black bg, color-coded
    clips), transport controls, clip-edit buttons (Split/Join via
    Shift+click, Lift/Drop), loop region, mode (Free/Sync) and Snap toggle.
    Keyboard shortcuts active on this tab only — see table below.
  - **MIXER**: per-lane gain fader (0–200%) and stereo pan knob.
  - **PROJ**: session save/load (persists tape, pool, mode, snap).
  - **TEST**: loopback latency and OP-Z onset-latency tests.
  All OP-Z channel-15 messages are forwarded through `OpzControlMode`.
  Also exposes `window.__tapeTest` — a structured state hook used by the
  hardware test scripts instead of parsing rendered text.
- [src/ui/renderers/TimelineRenderer.ts](src/ui/renderers/TimelineRenderer.ts) —
  Canvas drawing for clips (half-height, color-coded), beat-tick top band,
  loop region tint, and playhead.
- [src/sync/opzControlMode.ts](src/sync/opzControlMode.ts) — parses OP-Z
  channel-15 MIDI messages into typed `ControlEvent`s (lane select/mute,
  transport, edit, loop, encoder deltas). See
  [docs/op_z_appendix.md](docs/op_z_appendix.md).

### Hardware test automation
- [scripts/hardware-profile-setup.mjs](scripts/hardware-profile-setup.mjs) -
  one-time Playwright script: launches a persistent Chrome profile so you can
  grant the mic + MIDI permission prompts once.
- [scripts/hardware-test.mjs](scripts/hardware-test.mjs) - reuses that
  profile headfully with no further prompts; drives the OP-Z through the
  latency/Free/Sync checks and prints a pass/fail report.

## Control Reference

- [OP-Z control appendix](docs/op_z_appendix.md)
- [Keyboard control appendix](docs/keyboard_appendix.md)

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
- **BPM stabilisation**: the tape's internal BPM (used for the recording grid
  and beat-snap) is not updated from incoming MIDI clock until 48 pulses (~1
  second at 120 BPM) have been received after a Start, to avoid jitter from
  the OP-Z's clock warmup.
- **Snap vs mode**: the Snap toggle (X key) controls whether scrub, slide, and
  loop-point encoders quantise to the beat grid. It is independent of
  Free/Sync mode — you can have Free+Snap or Sync without snap.
