# OP-Z Control Appendix

This appendix describes Tape's OP-Z control surface. It applies only in
**Sync** mode. The OP-Z supplies normal MIDI Clock and transport; Tape follows
that timing while track 15 acts as the dedicated Tape controller.

## Connect the OP-Z

1. Connect the OP-Z over USB so it is available as class-compliant audio and
   MIDI.
2. In Tape's **COM** view, select the OP-Z as the MIDI input.
3. Also select it as the MIDI output. Output is required for encoder recentering
   and for Tape to keep the record-state LED in sync.
4. Select the OP-Z audio input/output where that is your intended audio path.
5. Set Tape to Sync mode.

Channels 1-14 are left for normal OP-Z musical and clock use. Tape consumes
only the controller messages described below on channel 15, the OP-Z Lights
track.

## Transport

Use the OP-Z's standard Play and Stop controls as the transport source. MIDI
Start starts Tape at the nearest beat to its current playhead; MIDI Stop stops
Tape. Tape does not map a separate channel-15 play control.

Hold the Tape Shift key and use OP-Z Stop to toggle Tape's Snap/grid behavior.

## Encoders

The first three track-15 encoders operate as relative controls in Tape even
though the OP-Z sends absolute CC values. Turn an encoder in either direction;
Tape acts on the change rather than the absolute position.

| Encoder | MIDI CC | Normal action | Shift action |
| --- | --- | --- | --- |
| Green | CC 1 | Scrub playhead | Slide the selected clip and playhead together |
| Blue | CC 2 | Shift the whole loop region | None |
| White | CC 3 | Move loop out | None |
| Orange | CC 4 | Set recording state | None |

With Snap on, the Green, Blue, and White controls move in beat steps. With Snap
off, they move in pixel-sized timeline steps. Each direction change contributes
one or more steps according to how far the encoder is turned.

Tape automatically sends a reset CC when CC 1-3 drift more than 30 steps from
centre (64). This returns the OP-Z control to centre and keeps both directions
available. The reset requires MIDI output to be selected.

## Recording Control

CC 4 is a record-state switch rather than a centred encoder.

- When Tape is not recording, any non-zero CC 4 value enables recording.
- When Tape is recording, any value below 127 disables it.
- Tape sends CC 4 value 127 for enabled and 0 for disabled whenever recording
  changes through any supported control, so the OP-Z LED reflects Tape state.

The OP-Z Record button remains available for its own sequencer workflow and is
not reassigned by Tape.

## Black-Key Map

All Tape keys are Note On/Off messages on MIDI channel 15. White keys are
ignored.

| Key | MIDI note | Normal action | Hold Shift |
| --- | --- | --- | --- |
| F#3 | 54 | Select lane 1 | Mute/unmute lane 1 |
| G#3 | 56 | Select lane 2 | Mute/unmute lane 2 |
| A#3 | 58 | Select lane 3 | Mute/unmute lane 3 |
| C#4 | 61 | Select lane 4 | Mute/unmute lane 4 |
| D#4 | 63 | Lift selected clip | Lift All in the loop region |
| F#4 | 66 | Drop clipboard | Merge Drop |
| G#4 | 68 | Split at playhead | Join with neighbour |
| A#4 | 70 | Set loop out | Set loop in |
| C#5 | 73 | Toggle loop | Set loop to selected clip |
| D#5 | 75 | Hold for Shift | N/A |

## Shift

Hold D#5 (note 75) while issuing a second command. Shift affects lane keys,
edit keys, Loop, encoder 1, and Stop as shown in the tables. Release D#5 to
return to normal behavior.

## Troubleshooting

- **No response from controls:** confirm Tape is in Sync mode and that the OP-Z
  is the selected MIDI input.
- **Encoders stop responding in one direction:** select the OP-Z as MIDI output
  so Tape can send its automatic recenter CCs.
- **Tape does not follow transport:** check that the OP-Z is emitting MIDI
  Clock/Start/Stop on the selected input and allow roughly two beats after
  Start for BPM stabilization.
- **Record LED is wrong:** reselect the OP-Z MIDI output, then toggle recording
  once so Tape sends its current CC 4 state.

For desktop keyboard alternatives, see
[keyboard_appendix.md](keyboard_appendix.md).