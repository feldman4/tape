# OP-Z Pads

A browser-based iRig/OP-Z controller, with mocked MIDI
workflow tests. Performance FX and hardware mappings need
verification. See the
[user manual](docs/MANUAL.md), [device setup](docs/device-setup.md),
[implementation notes](docs/implementation_notes.md), and
[iRig Pads control surface and MIDI reference](docs/irig-pads.md).

Interface concepts: [controller](docs/concept-controller.png),
[scenes](docs/concept-scenes.png),
[mixer](docs/concept-mixer.png), [drum kit](docs/concept-drum-kit.png),
[performance FX](docs/concept-performance-fx.png), and
[diagnostics](docs/concept-diagnostics.png). These are visual mockups; the
manual is authoritative where labels or behavior differ.

From the repository root:

```sh
npm install
npm run dev:opz-pads
npm run build:opz-pads
```

With the dev server running, use `npm run test:workflow --workspace=opz-pads`
to exercise the app with mocked Web MIDI devices. Set `OPZ_PADS_URL` to
override the server URL, or `OPZ_PADS_SCREENSHOTS` to a directory to save
rendered controller, scenes, drum and diagnostics views.

The typed engine separates MIDI decoding (`src/midi.ts`), controller gesture
state (`src/controller.ts`), parameter tracking (`src/parameter-state.ts`),
project validation (`src/model.ts`), and drum scene behavior (`src/scenes.ts`).
Storage formats and validation are in `src/storage.ts`. Web MIDI port access is isolated in
`src/devices.ts`, with the React UI in `src/App.tsx` and `src/views.tsx`.
iRig MIDI assignments and LED mappings are centralized in `src/irig-midi.ts`.
The shared hardware LED palette and gradients are in `src/irig-colors.ts`.
The mixer handles OP-Z level, pan, mute and mute-group controls; the empty
scene has no behavior. Drum playback and its audition timers belong to the
drum handler; performance FX behavior is in `src/performance-fx.ts`.
Parameter tracking keeps diagnostic input, DATA adjustment values, FX bases,
and successfully sent output separate; diagnostic output is the calculated value.
Entering and leaving the iRig check goes through the engine's check-mode
transitions so notes and temporary effects are released before routing changes.

Scene handlers receive timestamped controller and OP-Z events after the
controller state is updated. Event times use the Web MIDI monotonic clock;
direct engine calls default to `performance.now()`. Performance FX recognizes
bidirectional CC gestures using these timestamps.
LED updates send changed components; pad presses and releases resend both
colors immediately, and releases refresh again after 200 ms to reconcile the
iRig's own LED changes. Pressure refreshes are coalesced at most every 50 ms.
Explicit refreshes resend all LEDs to reconcile device scene changes and port
setup.

Run `npm run test:unit --workspace=opz-pads` for the engine tests (Node 23.6+
supports the type-stripping flag), and `npm run lint --workspace=opz-pads`
for linting. The build type-checks the engine and UI.
