# Staged Implementation Plan & Progress

This tracks the staged build-out described in [starting_plan.md](starting_plan.md),
and how far implementation has gotten. The full stage-by-stage plan (Stage 0
through Stage 8) is summarized below; day-to-day repo conventions/gotchas live
in repo memory, not here.

## Why staged, and why Stage 0 first

The biggest technical risk for this project is whether Free-mode and Sync-mode
recording can be made low-latency, drift-free, and musically usable at all —
everything else (multi-lane editing, mixer, DSP, persistence, UI polish) is
only worth building if that core is solid. So Stage 0 is a vertical-slice
feasibility spike: the *full* audio engine + MIDI sync engine, wired to a
minimal single-lane tape UI, validated against real hardware, before any of
the later stages begin.

**Go/no-go checkpoint** (blocks Stage 1+): Stage 0 must confirm
(a) round-trip latency is small/consistent enough to compensate reliably,
(b) Sync-mode resampling produces artifact-free, beat-accurate clips,
(c) no audible drift over multi-minute recordings — via manual testing with
real hardware (synth + audio interface + external MIDI clock source).

## Stage 0 — Feasibility Spike: Single-Lane Tape + Full Audio/Sync Engine

| # | Item | Status |
|---|------|--------|
| 1 | Project scaffold (Vite + React + TS, npm) | ✅ Done |
| 2 | AudioWorklet core (record + playback, sample-accurate) | ✅ Done |
| 3 | Audio Pool (minimal, in-memory) | ✅ Done |
| 4 | Tape/Clip data model (minimal, single lane) | ✅ Done |
| 5 | Transport (sample-accurate, driven by audio clock) | ✅ Done |
| 6 | Sync Engine (MIDI Clock/Start/Stop, tempo smoothing, Samples↔Beats) | ✅ Done |
| 7 | Free Mode recording path | ✅ Done |
| 8 | Sync Mode recording path (resample take to exact beat length) | ✅ Done |
| 9 | Latency instrumentation (loopback click test) | ✅ Done, tuned for reliability (see below) |
| 10 | Minimal Tape UI (Canvas waveform + playhead, transport controls) | ✅ Done |
| 11 | Manual hardware validation (real synth + interface + MIDI clock) | � Partial — automated OP-Z smoke test passing (see below); multi-minute drift check still open |

**Implemented, beyond the original plan:**
- Input **audio device selection** (dropdown, `AudioEngine.listInputDevices()` /
  `setInputDevice()`), since testing needs a real interface, not just the
  default mic.
- Input **MIDI device selection** (dropdown, `SyncEngine.listInputs()` /
  `setInputDevice()`), for the same reason.
- Both default to a connected device/input whose name contains "OP-Z" (the
  target hardware), falling back to the browser default otherwise.
- The loopback latency test's click was reworked from a 32-sample transient
  (too little energy to survive a real speaker→mic acoustic path) to a ~9ms
  Hann-windowed 2.5kHz tone burst, and its confidence score was changed from
  an unnormalized dot product to a normalized cross-correlation (range -1 to
  1, volume-independent) so "confidence" is actually meaningful. The UI flags
  results below 0.6 as unreliable.
- **MIDI output support** (`SyncEngine.sendNoteOn`/`sendNoteOff`/`sendStart`/`sendStop`)
  so the app can drive an OP-Z directly: trigger channel-1 percussion notes,
  and send MIDI Start to make the OP-Z emit its own MIDI Clock for Sync-mode
  tests. See docs/testing_proposal.md "Reference Source: OP-Z".
- **Onset detection** (`src/audio/onsetDetect.ts`, threshold/RMS-based) for
  measuring note-to-sound latency against an OP-Z hit, since (unlike the
  internal loopback click) its waveform isn't known in advance.
- **Automated hardware test scripts** (`scripts/hardware-test.mjs` +
  `scripts/hardware-profile-setup.mjs`, Playwright) that drive the whole
  Stage 0 hardware validation with no human interaction once a one-time
  permission-grant step has run. See docs/testing_proposal.md "Running the
  OP-Z hardware tests unattended".

**Automated smoke test results** (`npm run test:hardware`, OP-Z connected via
USB, 2026-07-25): all 6 checks passed — OP-Z selected as audio input + MIDI
input + MIDI output; note-to-sound latency ~50ms (52.4ms most recent run);
Free-mode recording produced a ~1.4s clip; Sync-mode recording produced an
~4.1s / 8.17-beat clip with no resampling artifacts observed. This confirms
(a) and (b) of the go/no-go checkpoint above for short takes.

**Current blocker:** the remaining go/no-go criterion — (c) no audible drift
over multi-minute recordings — hasn't been exercised yet; the automated
script's Sync-mode take is only ~8 beats. Everything else in Stage 0 is built
and passes `npm run build` / `npm run lint`, and has been smoke-tested in
real Chrome (mic + MIDI permission flows both work; VS Code's Simple Browser
does *not* support the Web MIDI permission prompt, so real Chrome/Edge is
required for testing).

### Stage 0 key files
- `src/audio/audioEngine.ts` — main-thread AudioContext/worklet wrapper, input device selection.
- `src/audio/worklets/tape-processor.ts` — AudioWorkletProcessor (record/playback/click).
- `src/audio/audioPool.ts` — in-memory immutable buffer store.
- `src/audio/clickWaveform.ts`, `src/audio/latencyTest.ts` — loopback latency self-test.
- `src/audio/onsetDetect.ts` — threshold/RMS onset detection for OP-Z note-to-sound latency.
- `src/sync/syncEngine.ts` — MIDI clock parsing, tempo smoothing, Samples↔Beats, input/output selection, note/Start/Stop sending.
- `src/tape/model.ts`, `src/tape/recording.ts` — Clip model, Free/Sync recording finalization.
- `src/ui/TapePage.tsx` — Canvas UI, device pickers, OP-Z test controls, and the `window.__tapeTest` hook.
- `src/ui/renderers/TimelineRenderer.ts` — Canvas waveform/playhead drawing.
- `scripts/hardware-profile-setup.mjs`, `scripts/hardware-test.mjs` — Playwright-based unattended OP-Z hardware validation.

## Stages 1-8 — Not started (blocked on Stage 0 go/no-go)

| Stage | Scope |
|-------|-------|
| 1 — Core Engine Foundation | Generalize to 4 lanes + Master, full Project/Tape/Lane/Clip/Mixer model, basic Mixer (Gain/Pan/Mute), Undo skeleton. |
| 2 — Edit Engine | Lift/Drop/Split/Join/Move as non-destructive ops, loop region, multi-level undo, clipboard. |
| 3 — Full Tape UI, Input & Gestures | Full 4-lane timeline renderer, gesture recognition, keyboard/MIDI-controller input, scrubbing, varispeed, reverse. |
| 4 — Mixer Page | Per-channel swipe view, 3-band EQ, Send A/B. |
| 5 — Tape DSP: Analog Mode | Wow/flutter, saturation, frequency shaping as switchable DSP stage. |
| 6 — Project Persistence & Settings | Save/export (OPFS/IndexedDB), device/MIDI settings page. |
| 7 — iPad / Safari Support | Touch gestures, Web MIDI availability fallback, mobile Safari audio tuning. |
| 8 — Future / Deferred | Limiter, Ableton Link, SMPTE/MTC, internal tempo source. |

## Next step

Exercise the remaining go/no-go criterion: no audible drift over multi-minute
recordings. Extend `scripts/hardware-test.mjs` (or run it manually) with a
Sync-mode take lasting several minutes against the OP-Z's MIDI Clock, and
inspect the resulting clip's stretch factor/beat alignment for drift. Once
that passes, item 11 can move to ✅ Done and Stage 0 is closed — Stage 1 can
begin.
