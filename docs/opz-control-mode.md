# OP-Z Control Mode

Tape uses the OP-Z's **track 15 (Lights)** row as a dedicated hardware control
surface. Connect the OP-Z via USB; it appears as both a MIDI input and output.
Select it as both the MIDI input and output in Tape's device pickers.

Control mode supports **Sync** operation only. The OP-Z's normal play and stop
controls remain the transport source; Tape follows MIDI clock and transport as
usual. Hold Tape Shift while using the OP-Z Stop control to set Tape's grid
resolution instead. Messages on channels 1–14 continue to work as before
(clock sync, percussion triggers, etc.).

---

## Encoders

The OP-Z rotary encoders send CC 1–4 on channel 15. CC 1–3 are converted from
their absolute values (0–127) into a **relative** stream internally: only the
*change* from the last position is acted on. CC 4 is a record-state control
with dedicated endpoint behavior.

To prevent the encoder from silently running out of range and going "dead",
Tape watches CC 1–3 and sends a **reset** CC back to the OP-Z whenever one
encoder drifts more than 30 steps from centre (64). This
recentres the encoder so it always has headroom in both directions.  You will
not feel anything mechanical — from your perspective the encoder is simply
continuous.

The four encoders follow the OP-1 Field tape-mode colour convention:

| Encoder | CC | Primary action | Shift action |
|---------|----|----------------|--------------|
| 1 (green)  | CC 1 | Scrub playhead — 1 beat/tick (Snap on) or 1 px/tick (Snap off) | **Slide clip** — moves selected clip and playhead together by the same amount |
| 2 (blue)   | CC 2 | Shift loop region — 1 beat/tick (Snap on) or 1 px/tick (Snap off) | — |
| 3 (white)  | CC 3 | Loop out point — 1 beat/tick (Snap on) or 1 px/tick (Snap off) | — |
| 4 (orange) | CC 4 | **Recording state** | — |

---

## Recording status

Tape uses **CC 4** on channel 15 to control recording. CC 4 is not centered:
its lowest value, **0**, represents off, and its highest value, **127**,
represents on. While recording is off, any non-zero CC 4 value enables it.
While recording is on, any CC 4 value below 127 disables it. Whenever Tape
enables or disables recording, whether from CC 4 or another control, it sends
CC 4 value 127 or 0 back to update the OP-Z track-15 LED. This replaces a
dedicated Tape record button, since the OP-Z's Record button is reserved for
recording into its step sequencer.

## Buttons (black keys)

All ten black keys are used for Tape control. All send Note On/Off on MIDI
channel 15. White keys are ignored.

| Note | MIDI # | Primary | Shift |
|------|--------|---------|-------|
| F#3  | 54 | **Tape 1** — select tape lane 1 | **Mute/Unmute Tape 1** |
| G#3  | 56 | **Tape 2** — select tape lane 2 | **Mute/Unmute Tape 2** |
| A#3  | 58 | **Tape 3** — select tape lane 3 | **Mute/Unmute Tape 3** |
| C#4  | 61 | **Tape 4** — select tape lane 4 | **Mute/Unmute Tape 4** |
| D#4  | 63 | **Lift** — lift active clip to clipboard | **Lift All** — lift all clips in loop region |
| F#4  | 66 | **Drop** — paste clipboard clip at playhead | **Merge Drop** — drop and merge with existing material |
| G#4  | 68 | **Split** — split active clip at playhead | **Join** — join clip with nearest neighbour |
| A#4  | 70 | **Loop Out** — set loop out point at playhead | **Loop In** — set loop in point at playhead |
| C#5  | 73 | **Loop Toggle** — loop on/off | **Loop Clip** — loop the current clip |
| D#5  | 75 | **Shift** — hold to activate secondary actions | — |

---

## Shift modifier

Hold **note 75 (D#5)** to activate Shift.  While Shift is held:

- Encoder 1 switches from scrub to slide clip.
- Tape 1–4 → mute or unmute the corresponding tape lane.
- Edit buttons: Lift → Lift All, Drop → Merge Drop, Split → Join.
- Loop Out → Loop In.
- Loop Toggle → Loop current clip.
- OP-Z Stop → Tape grid resolution.

Release note 75 to exit Shift.  This directly mirrors the OP-1 Field shift
convention: hold the key, act, release.

---

## Quick-reference card

```
 OP-Z keyboard, channel 15
 ─────────────────────────────────────────────────────────────────
  Sync transport: standard OP-Z Play/Stop
  Shift + Stop:  Tape grid resolution
  Record state:    CC 4 (0 = off, 127 = on)

  Black keys          primary            shift (hold D#5)
    54  F#3            Tape 1             Mute/unmute Tape 1
    56  G#3            Tape 2             Mute/unmute Tape 2
    58  A#3            Tape 3             Mute/unmute Tape 3
    61  C#4            Tape 4             Mute/unmute Tape 4
    63  D#4            Lift               Lift All
    66  F#4            Drop               Merge Drop
    68  G#4            Split              Join
    70  A#4            Loop Out           Loop In
    73  C#5            Loop Toggle        Loop Clip

  75  D#5               [SHIFT — hold]

  White keys            ignored

  Encoders              primary            shift
    CC 1  green         scrub              slide clip + playhead
    CC 2  blue          shift loop region  —
    CC 3  white         loop out point     —
    CC 4  orange        recording state
 ─────────────────────────────────────────────────────────────────
```

---

## Implementation notes

- **Absolute→relative conversion** happens in `src/sync/opzControlMode.ts`.
  The `OpzControlMode` class emits `encoderDelta` events (signed integer
  deltas) for CC 1–3 rather than their raw absolute values. CC 4 is a
  non-centered record-state control, not an encoder delta.
- **Reset threshold** is 30 steps from centre (64) for CC 1–3. Adjust
  `CC_RESET_THRESHOLD` in `opzControlMode.ts` if those encoders feel sluggish
  or reset too aggressively.
- **Snap mode** (toggled by the **X** key in the TAPE tab) determines the
  step size for encoders 1–3: when Snap is on, each tick moves by one
  beat; when Snap is off, each tick moves by one pixel of the current zoom.
  Snap is independent of Free/Sync mode and is saved with the session.
- `OpzControlMode` uses `addEventListener('midimessage')` on the shared
  `MIDIAccess`, so it coexists with `SyncEngine`'s clock/transport listener
  on the same MIDI port without conflict.
- The OP-Z must be selected as the **MIDI output** as well as input for the
  encoder-reset feature to work (Tape sends a CC back to recentre the
  encoder).  If no output is selected the app still functions; encoders simply
  won't auto-reset.
- OP-Z control mode consumes only the ten black-key mappings described above;
  it does not map white keys or a dedicated record or play button. Shift plus
  the standard OP-Z Stop control sets Tape's grid resolution.
