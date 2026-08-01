# Keyboard Control Appendix

Keyboard controls are active only in the **TAPE** view unless noted otherwise.
Typing in a text field, select, or other form control does not trigger Tape
actions. Standard browser shortcuts using `Command` or `Control` are left
alone.

## View Selection

These shortcuts work anywhere in the app:

| Shortcut | View |
| --- | --- |
| `Option`+`1` | TAPE |
| `Option`+`2` | MIXER |
| `Option`+`3` | PROJ |
| `Option`+`4` | COM |
| `Option`+`5` | TEST |

## Tape Commands

| Shortcut | Action |
| --- | --- |
| `1` to `4` | Select lane 1 to 4 |
| `Shift`+`1` to `4` | Mute or unmute lane 1 to 4 |
| `R` | Arm, start, or stop recording as the transport state permits |
| `Space` | In Free mode, play or pause; when recording is armed, start a four-click count-in then record |
| `Escape` | Stop, or rewind when already stopped, in Free mode |
| `M` | Toggle the metronome click |
| `[` | Set loop in at playhead |
| `]` | Set loop out at playhead |
| `\\` | Toggle loop playback |
| `Shift`+`\\` | Set the loop to the selected clip |
| `S` | Split selected clip at playhead |
| `Shift`+`S` | Join selected clip with a neighbour |
| `L` | Lift selected clip |
| `Shift`+`L` | Lift All from the loop region |
| `D` | Drop clipboard at playhead |
| `Shift`+`D` | Merge Drop the Lift All clipboard |
| `Z` | Undo |
| `Shift`+`Z` | Redo |
| `O` | Toggle Free and Sync mode |
| `X` | Toggle beat Snap |

In Sync mode, `Space` and `Escape` do not drive the tape. Use MIDI Start and
Stop from the connected hardware instead.

## Keyboard Encoder Emulation

Hold one of these keys and move the mouse horizontally. Every 14 pixels produces
one encoder tick. Hold `Shift` during movement for the special action where one
exists.

| Hold key | Emulated encoder | Normal action | Shift action |
| --- | --- | --- | --- |
| `Q` | Green / 1 | Scrub playhead | Slide selected clip and playhead |
| `W` | Blue / 2 | Shift loop region | None |
| `E` | White / 3 | Move loop out | None |
| `F` | Orange / 4 | No assigned Tape action | None |

Snap determines the movement unit: one beat per tick when on and a timeline
pixel-sized increment when off. The `F` mapping exists for parity with the
four-encoder controller layout but currently produces no Tape action.