# iRig Pads control surface and MIDI reference

Summary of the supplied *iRig Pads* manual, English sections 4-11
(pp. 8-30). Assignments below are factory defaults, not a fixed protocol:
each scene can be edited. Note names use the manual's octave labels.

## Surface and operation

- 16 velocity-sensitive, illuminated pads; two knobs; one slider; a
  24-step endless DATA encoder with pushbutton; buttons 1 and 2; SCENE and
  FIX VEL buttons; and a TRS input for a sustain or expression pedal.
- USB MIDI is class-compliant. The unit has user/programmable and
  externally controlled operating modes. The manual's editing and factory
  details describe user/programmable mode.
- Pads can send notes or CCs with individual MIDI channels. In temporary
  note mode, press sends Note On and release sends Note Off; in toggle mode,
  successive presses send On and Off. Holding a pad in temporary note mode
  sends channel aftertouch. Pad CCs support temporary/toggle operation and
  absolute (127/0) or velocity-dependent relative values.
- Knobs and slider send CC values 0-127; they can also be assigned pitch
  bend and MIDI channels. The DATA encoder supports CC or program change
  and a MIDI channel. In absolute CC mode it increments/decrements by one,
  saturating at 0/127. In relative CC mode the manual's play-mode table
  lists clockwise values 1, 2, 4, 6, 8 and counterclockwise values 127,
  126, 124, 123, 121 for increasing speed. The edit section describes a
  broader range (0-10 and 127-117), so verify actual device behavior.
- Buttons 1, 2 and DATA push, and the pedal, can be assigned note, CC,
  program change and channel. Buttons are not velocity-sensitive. FIX VEL
  toggles fixed pad velocity 100; otherwise velocity follows the strike.

## Factory scenes

At factory startup scene 1 is loaded. Scenes 1, 2 and 5-8 are populated;
3, 4 and 9-16 are empty. Pads are listed in **pad-number order**, not
physical row order. Pad channel is 1 for scenes 1-2 and 10 for 5-8.

| Scene | Name | Pad notes 1-16 |
| --- | --- | --- |
| 1 | General MIDI Drum Kit | B0, C1, D1, E1, C#1, D#1, F#1, G#1, D2, A1, F1, A#1, D#2, F2, C#2, E2 |
| 2 | Chromatic | C1, C#1, D1, D#1, E1, F1, F#1, G1, G#1, A1, A#1, B1, C2, C#2, D2, D#2 |
| 5 | AKAI MPC Bank A / iMPC PRO | C#1, C1, F#1, A#4, E1, D1, A#1, G#1, C2, B1, A1, G1, C#2, G2, D#2, F2 |
| 6 | AKAI MPC Bank B | E-1, F-1, F#-1, G-1, G#-1, A-1, A#-1, B-1, C0, C#0, D0, D#0, E0, F0, F#0, G0 |
| 7 | AKAI MPC Bank C | G#0, A0, A#0, B0, C1, C#1, D1, D#1, E1, F1, F#1, G1, G#1, A1, A#1, B1 |
| 8 | AKAI MPC Bank D | C2, C#2, D2, D#2, E2, F2, F#2, G2, G#2, A2, A#2, B2, C3, C#3, D3, D#3 |

Other factory controls use channel 1: knob 1 CC 10, knob 2 CC 11, slider
CC 1, DATA encoder CC 7 absolute, footswitch CC 64 momentary, expression
pedal CC 11. In scenes 1-2, button 1 is CC 20 toggle, button 2 CC 21
toggle and DATA push CC 22 temporary. Scenes 6-8 use the same assignments
but DATA push is toggle. Scene 5 instead uses temporary notes: button 1 G3
(REC), button 2 G#4 (PLAY), DATA push C#2 (bank selection).

## Host-to-device MIDI

The device receives on **MIDI channel 1**, independent of scene transmit
assignments. The manual specifies one CC per LED color, with values 0-127
controlling intensity. Pairs below are **red / green**, in the order given
by the manual; send separate CCs to set both components.

| Control | Red / green CC | Control | Red / green CC |
| --- | --- | --- | --- |
| SCENE | 21 / 20 | FIX VEL | 23 / 22 |
| Button 1 | 25 / 24 | Button 2 | 27 / 26 |
| Pad 1 | 95 / 94 | Pad 2 | 97 / 96 |
| Pad 3 | 99 / 98 | Pad 4 | 101 / 100 |
| Pad 5 | 87 / 86 | Pad 6 | 89 / 88 |
| Pad 7 | 91 / 90 | Pad 8 | 93 / 92 |
| Pad 9 | 79 / 78 | Pad 10 | 81 / 80 |
| Pad 11 | 83 / 82 | Pad 12 | 85 / 84 |
| Pad 13 | 71 / 70 | Pad 14 | 73 / 72 |
| Pad 15 | 75 / 74 | Pad 16 | 77 / 76 |

The manual says incoming program changes **1-16** switch scenes; it does
not clarify whether those numbers are raw MIDI data bytes or one-based UI
labels. Verify numbering on hardware before relying on remote switching.

## Scene editing

Press SCENE then a populated pad to recall; hold SCENE for over two seconds
then press a pad to store, overwriting any existing scene. In recall or
store mode, hold a scene pad for over two seconds to erase it. Factory
restore (SCENE + FIX VEL while powering up) deletes user programming.

Press SCENE + FIX VEL to enter edit mode. Use the pads to select a global
parameter or operate the control to edit it; pad 16 confirms, SCENE or FIX
VEL exits. Scene settings include global channel, pad sensitivity and octave
shift, and individual control assignments. Numeric entry uses pads 1-9
for digits 1-9 and pad 10 for 0. Consult manual section 10 for the full
control-specific sequences.
