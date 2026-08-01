# Tape Architecture Summary

**Snapshot date:** 2026-08-02

This is a factual snapshot of the current implementation, followed by
an architectural critique for laptop and iPad deployment. It replaces the
forward-looking architecture section of the old planning document; it does not
claim that planned features are already implemented.

## Runtime Shape

Tape is a Vite, React, and TypeScript browser application. Its runtime has two
execution domains:

```text
React UI / orchestration thread
  -> semantic TapeAction dispatch
  -> tape state, session persistence, MIDI coordination
  -> AudioEngine main-thread bridge
  -> AudioWorklet processor
  -> audio input/output
```

The browser UI owns React state and browser integrations. The audio worklet
owns real-time record/playback/mixing operations on the audio rendering thread.
Timing in the worklet uses absolute audio sample frames rather than wall-clock
time.

## Main Modules

| Area | Current responsibility |
| --- | --- |
| `src/ui/TapePage.tsx` | Application composition, device initialization, React state, MIDI event coordination, canvas interaction, keyboard bindings, tests hooks, and tab wiring. |
| `src/ui/hooks/useTapeDispatch.ts` | Central reducer-like executor for `TapeAction` commands. It coordinates state mutations, transport, edit operations, persistence, and engine calls. |
| `src/ui/inputAdapters.ts` | Pure translation from keyboard and OP-Z controller events into device-neutral `TapeAction` values. |
| `src/tape/model.ts` | Four-lane Tape, Lane, and Clip data definitions. Clip placement is expressed in samples. |
| `src/tape/editEngine.ts` | Pure clip-metadata edits such as split, move, join, lift, and drop. |
| `src/tape/recording.ts` | Finalizes raw takes into clips. |
| `src/tape/session.ts` | Persists named sessions and referenced audio buffers in IndexedDB. |
| `src/audio/audioEngine.ts` | Main-thread wrapper around `AudioContext` and `AudioWorkletNode`; enumerates/selects audio devices and bridges commands/events. |
| `src/audio/worklets/tape-processor.ts` | Audio-thread duplex tape processor for recording, playback, mixing, and click scheduling. |
| `src/audio/audioPool.ts` | In-memory immutable audio-buffer storage. |
| `src/sync/syncEngine.ts` | Web MIDI access, input/output selection, MIDI Clock/Start/Stop parsing, tempo estimation, and MIDI/audio clock conversion. |
| `src/sync/opzControlMode.ts` | Channel-15 OP-Z controller decoding, shift tracking, relative encoder conversion, and encoder-reset MIDI output. |
| `src/ui/renderers/TimelineRenderer.ts` | Canvas drawing of timeline clips, loop region, beat ticks, and playhead. |

## State and Data Flow

The authoritative project data is a `Tape` value: four lanes, their clips and
mixer values, active lane, playhead, tape length, loop bounds/state, BPM, and
recording gain. Audio samples live in `AudioPool`; clips reference an immutable
buffer plus source and tape offsets.

Input is partially normalized before state mutation:

```text
Keyboard / OP-Z MIDI
  -> inputAdapters
  -> TapeAction
  -> useTapeDispatch
  -> React Tape state + AudioEngine / SyncEngine effects

Canvas mouse events
  -> TapePage handlers
  -> partly direct state updates, partly TapeAction
```

Sessions save Tape metadata, referenced sample buffers, mode, and Snap into
browser-local IndexedDB. Reloading rehydrates the pool and clip references. No
server, account, or shared project store is involved.

## Timing and Sync

The audio worklet is responsible for sample-frame playback and recording. The
main thread receives playhead updates and renders them in React/canvas. MIDI
events originate in a `performance.now()` time domain. `SyncEngine` converts
between that domain and audio time through `AudioContext.getOutputTimestamp()`
and derives a smoothed BPM from MIDI Clock.

Free mode uses audio-interface timing for take placement. Sync mode follows
external MIDI transport and aligns recording to the grid. BPM updates begin
only after 48 clock pulses following MIDI Start to prevent warmup jitter from
the external source destabilizing the grid.

## What Is Already Well Separated

- Real-time DSP is isolated in an AudioWorklet rather than running in React.
- Audio buffers are immutable and distinct from clip metadata, which supports
  non-destructive editing and economical repeated drops.
- Pure edit functions and the `TapeAction` type make much of the domain behavior
  testable without browser UI input.
- Device-specific keyboard and OP-Z messages already converge through
  `inputAdapters.ts` for most commands.
- Session serialization is outside the UI rendering components.

## Separation-of-Concerns Critique

The codebase has made a meaningful start on a controller/action boundary, but
the boundary is incomplete. The current architecture is workable for a laptop
prototype and hardware validation, yet it will make a polished iPad deployment
harder than necessary.

### `TapePage` Is a High-Coupling Composition Root

`TapePage.tsx` creates and coordinates the audio engine, sync engine, OP-Z
controller, device discovery, latency calibration, MIDI listeners, React
transport state, rendering loop, keyboard listeners, mouse interaction, test
hook, and tab presentation. This makes it difficult to reuse the same product
logic with a different presentation shell. A tablet-specific interaction model
would either grow this component further or replicate orchestration logic.

**Recommended direction:** extract an application controller/service that owns
engine lifecycle and action effects, exposes a subscribable view model, and is
driven by explicit capability adapters. React components should bind controls
and render state, rather than own browser/hardware wiring.

### Canvas Interaction Bypasses the Action Boundary

Keyboard and OP-Z input produce `TapeAction` values, but canvas drag handlers
perform some direct `setTape` mutations before later dispatching a commit. The
business rules for seeking, moving, snap calculation, selection, and undo are
therefore divided between the view and dispatcher.

**Why it matters for iPad:** pointer/touch gestures need their own state machine
(press, drag, cancellation, pinch, multi-touch), so duplicated editing rules
are likely. The current canvas only registers mouse events; it has no complete
Pointer Events or touch-gesture contract.

**Recommended direction:** define device-neutral interaction intents such as
`seek`, `beginMove`, `previewMove`, `commitMove`, `cancelMove`, `selectClip`,
and `setViewport`. Feed mouse, keyboard, OP-Z, and touch adapters into those
intents. Make the domain/controller calculate snap and allowed transitions.

### Presentation Geometry Leaks Into Domain Behavior

With Snap off, OP-Z and keyboard encoder behavior depends on a timeline pixel
increment. The canvas has fixed dimensions, and the drag behavior includes a
mouse-specific speed multiplier. Those display units form part of user behavior
instead of being an explicitly configurable musical/time-space policy.

**Why it matters for iPad:** screen density, orientation, viewport size, and
touch precision differ substantially from a laptop. A fixed 620px canvas and
pixel-derived movement cannot provide equivalent control across devices.

**Recommended direction:** express all domain movements in samples, beats, or a
named normalized viewport unit. Keep pixel-to-time conversion in the renderer/
interaction adapter. Introduce responsive timeline layout and a separate
viewport model.

### Browser Capability Assumptions Are Not Isolated

The desktop path relies on Chromium-family Web MIDI and desktop-style audio
device selection. iPad needs the MIDIWEB browser to provide Web MIDI, which
makes the app runnable but does not guarantee desktop-equivalent permissions,
audio sink selection, background behavior, USB routing, or layout space.

**Recommended direction:** add a `PlatformCapabilities` layer that reports MIDI
availability, audio-output selection support, persistent-storage confidence,
pointer/touch support, and viewport class. UI should progressively disclose
only controls backed by the active platform and supply clear device guidance.
Test iPad/MIDIWEB as a first-class target instead of treating it as a browser
variant of the desktop build.

### Timing, UI State, and Lifecycle Need Stronger Boundaries

Several real-time callback values are mirrored between React state and mutable
refs to avoid stale closures. This is pragmatic in React, but it makes lifecycle
ownership and teardown difficult to reason about. The render loop uses
`Date.now()` to display a recording playhead even though the audio path is
sample-clock based.

**Why it matters for iPad:** mobile browser throttling, audio-session
interruptions, device changes, and orientation changes create more lifecycle
edges. UI wall-clock approximation can visibly diverge from the audio engine.

**Recommended direction:** make the transport controller expose a single
sample-clock-derived snapshot stream. Give engines explicit `start`, `suspend`,
`resume`, `reconfigure`, and `dispose` lifecycle methods that the platform shell
can invoke on visibility and audio-session changes.

### Persistence Is Browser-Local but Product Semantics Are Unclear

IndexedDB persistence is correctly separated at the module level, but it is
bound to a browser profile and has no import/export or storage-health policy.
That is especially significant on mobile browsers, where storage eviction,
private browsing, and browser switching are more common.

**Recommended direction:** define a project repository interface above
IndexedDB, surface save failures and storage estimates, and add an explicit
portable project/audio export before positioning iPad as a dependable field
recorder.

## Deployment Priorities

1. Establish capability detection and tested lifecycle behavior for MIDIWEB on
   iPad, including audio/MIDI reconnect and interruptions.
2. Replace mouse-only canvas input with Pointer Events plus a touch gesture
   adapter; define single-finger selection/drag and multi-touch viewport rules.
3. Make timeline layout responsive and move pixel-dependent behavior out of
   domain actions.
4. Continue moving orchestration from `TapePage` into a testable controller and
   send every interaction through a single intent/action pathway.
5. Add portable project export/import and test persistence under iPad storage
   constraints.
6. Validate latency and long-running sync drift on each supported hardware and
   browser combination.

These changes preserve the existing audio-worklet and immutable-buffer strengths
while making the application adaptable to the very different interaction and
lifecycle conditions of laptop and iPad use.