# OP-Z Pads

A first pass at a browser-based iRig/OP-Z controller, with mocked MIDI
workflow tests. Mixer, performance FX and kit-library workflows remain
unimplemented; hardware mappings need verification. See the
[user manual and current setup](docs/MANUAL.md),
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
