# OP-Z Control Mode

Tape uses the OP-Z's **track 15 (Lights)** row as a dedicated hardware control
surface, mirroring the ergonomics of the OP-1 Field tape section.  Connect the
OP-Z via USB; it appears as both a MIDI input and output.  Select it as both
the MIDI input and output in Tape's device pickers.

All messages on this page are on **MIDI channel 15**.  Messages on channels
1–14 continue to work as before (clock sync, percussion triggers, etc.).

---

## Encoders

The four OP-Z rotary encoders send CC 1–4 on channel 15.  Because the OP-Z
always emits **absolute** CC values (0–127), Tape converts them to a
**relative** stream internally: only the *change* from the last position is
acted on.

To prevent the encoder from silently running out of range and going "dead",
Tape watches the absolute value and sends a **reset** CC back to the OP-Z
whenever one encoder drifts more than 30 steps from centre (64).  This
recentres the encoder so it always has headroom in both directions.  You will
not feel anything mechanical — from your perspective the encoder is simply
continuous.

The four encoders follow the OP-1 Field tape-mode colour convention:

| Encoder | CC | Primary action | Shift action |
|---------|----|----------------|--------------|
| 1 (green)  | CC 1 | Loop out point — adjust by 1 beat per tick, snapped to grid | Loop in point — same |
| 2 (blue)   | CC 2 | Scrub tape position (sync: 1 beat/tick on grid; free: 1 px/tick) | *(reserved — slide clip)* |
| 3 (white)  | CC 3 | *(reserved — tape speed)* | *(reserved)* |
| 4 (orange) | CC 4 | *(reserved — recording level)* | *(reserved — recording pan)* |

---

## Buttons (black keys)

Black keys are grouped by function.  All send Note On/Off on channel 15.

### Tape edit  (octave 3)

| Note | MIDI # | Primary | Shift |
|------|--------|---------|-------|
| F#3  | 54 | **Lift** — lift active clip to clipboard | **Lift All** — lift all clips in loop region |
| G#3  | 56 | **Drop** — paste clipboard clip at playhead | **Merge Drop** — drop and merge with existing material |
| A#3  | 58 | **Split** — split active clip at playhead | **Join** — join clip with nearest neighbour |

### Transport  (octave 4, lower)

| Note | MIDI # | Primary | Shift |
|------|--------|---------|-------|
| C#4  | 61 | **Record** — toggle record arm | **Arm** — arm with count-in |
| D#4  | 63 | **Play** — start playback; pause if playing | **Reverse** — play in reverse |
| F#4  | 66 | **Stop** — pause if playing; rewind to tape start (or loop in) if paused | **Grid** — set tape grid resolution |

### Loop  (octave 4/5, upper)

| Note | MIDI # | Primary | Shift |
|------|--------|---------|-------|
| G#4  | 68 | **Loop In** — set loop in point at playhead | — |
| A#4  | 70 | **Loop Out** — set loop out point at playhead | — |
| C#5  | 73 | **Loop Toggle** — loop on/off | **Loop Clip** — loop the current clip |

### Modifier

| Note | MIDI # | Action |
|------|--------|--------|
| D#5  | 75 | **Shift** — hold to activate secondary actions |

All non-sharp (white) keys on channel 15 are reserved for future use and are
currently ignored.

---

## Shift modifier

Hold **note 75 (D#5)** to activate Shift.  While Shift is held:

- Encoders switch to their secondary action (e.g. scrub → slide clip,
  recording level → recording pan, loop out → loop in).
- Transport buttons: Record → arm with count-in, Play → reverse, Stop →
  tape grid resolution.
- Edit buttons: Lift → Lift All, Drop → Merge Drop, Split → Join.
- Loop Toggle → Loop current clip.

Release note 75 to exit Shift.  This directly mirrors the OP-1 Field shift
convention: hold the key, act, release.

---

## Quick-reference card

```
 OP-Z keyboard, channel 15
 ─────────────────────────────────────────────────────────────────
  Tape edit (oct 3)     primary            shift (hold D#5)
    54  F#3             Lift               Lift All
    56  G#3             Drop               Merge Drop
    58  A#3             Split              Join

  Transport (oct 4 lo)  primary            shift
    61  C#4             Record             Arm (count-in)
    63  D#4             Play / Pause       Reverse
    66  F#4             Pause / Rewind     Grid resolution

  Loop (oct 4/5)        primary            shift
    68  G#4             Loop In            —
    70  A#4             Loop Out           —
    73  C#5             Loop Toggle        Loop Clip

  75  D#5               [SHIFT — hold]

  White keys  (reserved)

  Encoders              primary            shift
    CC 1  green         loop out point     loop in point
    CC 2  blue          scrub              (slide clip — todo)
    CC 3  white         (tape speed — todo)
    CC 4  orange        (record level — todo)
 ─────────────────────────────────────────────────────────────────
```

---

## Implementation notes

- **Absolute→relative conversion** happens in `src/sync/opzControlMode.ts`.
  The `OpzControlMode` class emits `encoderDelta` events (signed integer
  deltas) rather than raw absolute CC values.  Consumers never see the raw
  absolute stream.
- **Reset threshold** is 30 steps from centre (64).  Adjust `CC_RESET_THRESHOLD`
  in `opzControlMode.ts` if encoders feel sluggish or reset too aggressively.
- `OpzControlMode` uses `addEventListener('midimessage')` on the shared
  `MIDIAccess`, so it coexists with `SyncEngine`'s clock/transport listener
  on the same MIDI port without conflict.
- The OP-Z must be selected as the **MIDI output** as well as input for the
  encoder-reset feature to work (Tape sends a CC back to recentre the
  encoder).  If no output is selected the app still functions; encoders simply
  won't auto-reset.
