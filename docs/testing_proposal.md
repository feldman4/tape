# Testing Strategy

The project should be designed so that nearly all timing and synchronization behavior can be tested automatically. Tests should produce deterministic audio and metadata for offline analysis rather than requiring human listening.

## Test Levels

| Level      | Goal                         | Hardware                          |
| ---------- | ---------------------------- | ---------------------------------- |
| Unit       | DSP correctness              | None                               |
| Engine     | Playback, editing, transport | None                               |
| Browser    | Scheduling, AudioWorklet     | None                               |
| Interface  | Audio + MIDI latency         | OP-Z via USB (class-compliant audio + MIDI) |
| End-to-end | MIDI sync + recording        | OP-Z via USB (class-compliant audio + MIDI) |

## Reference Source: OP-Z

Rather than a software-only reference sequencer, a Teenage Engineering OP-Z connected over a single USB cable (class-compliant audio interface + MIDI in/out) acts as the physical reference source for Interface and End-to-end tests. The app drives the OP-Z in two ways:

1. **Triggered percussion hits.** The app sends MIDI note-on messages to the OP-Z on channel 1 (percussion track). Each note produces a sharp, repeatable percussive transient on the OP-Z's audio output, which is recorded back into the app over USB audio. This replaces the software-generated "audio click/impulse" reference: the app knows exactly when it sent each note and can cross-correlate the recorded audio to find the matching onset.
2. **Transport-driven MIDI Clock.** The app sends a "Play" command (MIDI Start) to the OP-Z. The OP-Z starts its own sequencer at its configured project tempo and begins transmitting MIDI Clock/Start/Stop back to the app over USB MIDI. If the running pattern also includes percussion hits, the same session yields a paired audio + MIDI Clock reference whose relative timing is fixed by the OP-Z's own sequencer, similar to a software reference generator, but with the real hardware in the loop.

Implications versus a pure software reference:

* Tempo is set by the OP-Z's project tempo before a test run; sweep it across runs for tempo coverage rather than varying it live.
* Jitter is whatever the OP-Z's real clock jitter is (not programmable) — this is a feature, not a limitation, since it's the same jitter the app will see with any real hardware sequencer.
* Every measurement includes the OP-Z's own internal note-to-sound latency in addition to USB audio/MIDI transport latency. This is acceptable (and arguably more representative) because the real product use case always goes through an external instrument.

## Offline Analysis

Tests should analyze exported audio rather than relying on human audition.

Useful techniques include:

* cross correlation
* impulse detection
* zero-crossing detection
* beat interval measurement
* waveform comparison
* sample-by-sample comparison

Each test produces a pass/fail report with measured timing errors.

## DSP Tests

Verify mathematical correctness of operations.

* split + join == original
* reverse(reverse(x)) == x
* lift + drop at same position == original
* playback matches source
* interpolation accuracy
* tape DSP regression

These require no browser timing.

## Browser Timing

Verify transport and scheduling.

Examples:

* metronome clicks occur at expected sample positions
* transport starts on correct sample
* loop boundaries are sample accurate
* playback remains deterministic

## Audio Interface

Measure round-trip note-to-sound latency using the OP-Z as the trigger source.

Procedure:

1. Send a MIDI note-on to the OP-Z, channel 1 (percussion), and note the sample frame it was sent on.
2. Record the OP-Z's audio output over USB.
3. Detect the resulting percussive onset (cross-correlation / transient detection) and measure its sample offset from the sent note.
4. Repeat many times, ideally across multiple percussion voices/velocities, to check consistency.

Report:

* mean latency
* standard deviation
* minimum
* maximum

This becomes the note-to-sound calibration used for Free-mode recording placement. Unlike a pure electrical loopback, this figure includes the OP-Z's own internal trigger latency — which is correct, since that's the real path audio takes in normal use.

## Sync Recording

Send "Play" to the OP-Z so it starts its own sequencer and begins transmitting MIDI Clock/Start/Stop over USB. Run a pattern on the OP-Z's percussion track so the recorded audio contains onsets whose beat positions are implied by the OP-Z's own tempo and pattern length.

Record using Sync mode.

After finalization:

* reconstruct clip
* compare recorded percussion onsets against the MIDI Clock beat positions received during recording
* measure beat alignment
* verify stretch factor
* verify drift
* verify jitter rejection (against the OP-Z's real clock jitter, not a synthetic one)

## Property Testing

Generate random tape layouts and random edit sequences.

Verify invariants:

* no lost samples
* no unintended duplicated samples
* clip ordering remains valid
* joins remain continuous
* undo restores previous state

Useful for long-running fuzz tests.

## Diagnostics Mode

Provide a non-user-facing diagnostics mode that records timing metadata alongside every take.

Example:

```json
{
  "recordStartSample": 123456,
  "recordStopSample": 456789,
  "interfaceLatency": 312,
  "timestampSource": "midi_clock",
  "stretchFactor": 0.9901,
  "renderedClipLength": 176400,
  "clockEvents": [
    { "sample": 123500, "beat": 100.000 },
    { "sample": 124420, "beat": 100.042 }
  ]
}
```

This metadata enables deterministic regression testing and greatly simplifies debugging synchronization issues.
