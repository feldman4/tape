# OP-Z Pads manual

> **Implementation status:** This document describes the target design.
> The current first pass implements the controller display, scene types
> (empty and drum), mixer controls, drum note learning/playback and parameter control,
> project storage/import/export, and an incoming CC diagnostics grid.
> Performance FX, kit library and offset plotting below are not
> implemented. Do not rely on them yet.

For device setup, see [iRig Pads and OP-Z setup](device-setup.md).

In Scenes, configure a slot as a drum kit. Selecting a different type
replaces its contents. Select it physically on the iRig. Learning is
disabled until an OP-Z MIDI Stop message is received; then hold an iRig
pad and play a note on OP-Z channel 1–4. A Start or Continue disables
learning again. When a parameter is moved, audition notes repeat every
120 ms until 200 ms after the last movement or until release. Absolute
pots and the compression fader establish their starting point on the first
message; DATA uses signed relative values. Project JSON files are versioned and validated;
loading or creating a project replaces the current one after confirmation.
The diagnostics plot displays the last 10 seconds of incoming messages
(up to 100 per CC); values are unknown until received, and offset plotting is
not implemented.

OP-Z Pads uses an iRig Pads controller alongside an OP-Z and Ableton Live.
Use the iRig's pads, pots, buttons, DATA encoder and fader to control a
mixer, play drum kits and shape performance effects. The app displays the
controller and its state; its on-screen pads and controls are for viewing,
not for operating the hardware. The controller view shows the iRig layout,
including the app's understanding of the fader position, pad and button
presses, and LED colors and brightness.
The bottom gutter is hidden by default; press **~** (or the unshifted
backtick key) to show or hide it. It logs the last 100 pad LED color messages
sent to the iRig, including failed attempts, even while hidden. A successful
send does not confirm the LED changed.

## Scenes and projects

A project contains 16 scene slots. Scene 1 is always the mixer. Slots 2-16
can contain drum kits or performance FX scenes. Select a scene using the
iRig's **SCENE** button and the corresponding pad, then use a scene-specific
control to tell the app which scene is active. The app shows its last detected
scene and the 16 slots, with colors or icons identifying their types.
The iRig's pad LEDs reflect the state known to the app.

## Mixer: scene 1

The 16 pads correspond to OP-Z tracks and MIDI channels 1–16.
In this scene, active and unknown pad LEDs show each track's fader scale:
bright green means no reduction, shifting to orange by half scale, then
dimming to a faint orange at zero. Muted pads are dark;
active pads remain lit even at zero. The
mixer view shows a gray underlying level bar per track, overlaid
by a colored bar for its final level after fader scaling, and a 10-by-16
mute-group matrix using filled and hollow dots. Track colors are cyan for tracks 1-4,
green for 5-8, purple for 9-12 and orange for 13-16.
Its controller status also shows whether iRig buttons 1 and 2 are held.

- Hold one or more pads and turn **pot 1** to set their levels, or
  **pot 2** to set their pan, directly from the pot position.
- Hold one or more pads and move the **fader** to scale their volume on the
  Ableton output as a fraction of their underlying OP-Z levels.
- Hold **button 1** and tap pads to mute or unmute the corresponding tracks.
  This also stops sounding notes on those tracks in Ableton Live.
- Hold **button 2** and tap pads 1-10 to select OP-Z mute groups 1-10.
  While held, the current group's pad is bright orange and the other group
  pads are dim orange. Pads 11-16 are off and do not select a mute group.
  Releasing the button restores the track display. OP-Z mute groups store
  different track mute configurations.
- Turn pot 1 to show track levels as green LED brightness, or pot 2 to show
  pan positions as a gradient from red (left) to green (right), whether or not
  pads are held.
  Unknown values stay dark. In the level display, known zero values use minimum
  brightness for active or unknown tracks and stay dark for muted tracks.
  These temporary displays can light muted tracks when their values are known.
  If a pot is moved with pads held, its display remains until all pads are
  released, even if the held pads change. Otherwise, the usual mute display
  returns one second after the last pot movement or after a pad interaction.
  The button-2 mute-group display takes precedence.

The pots set absolute values from 0 to 127, even when the previous value is
unknown. Pot 1 also establishes a new underlying level for the fader. The fader
scales each held track's underlying level, preserving it across pad releases;
it needs a level previously set by pot 1 or received from OP-Z. Configure OP-Z
outgoing track channels and parameter CCs to match the incoming MIDI table to
receive level and pan updates. Incoming level changes establish a new underlying
level, while the fader scale stays in effect. Pot 1 sends the underlying level
to OP-Z; the fader never sends level changes to OP-Z. Both pot 1 changes and
incoming OP-Z levels are scaled on their way to the Ableton output.

Track mutes start unknown, and the active mute group is assumed to be group 1
until another group is selected or reported. If a track's mute state is
unknown, the first button-1 toggle assumes it is unmuted and sends mute.
Each toggle also sends All Sound Off (CC 120) and All Notes Off (CC 123) on
that track's channel to the Ableton output. The matrix shows mute states
received or changed for the selected or assumed group; other cells remain
unknown. Group observations are cleared and group 1 is assumed again on
incoming pattern changes and OP-Z input reconnection. OP-Z MIDI does not
provide a complete mute-group readback, so external changes may leave the
display incomplete or stale.

## Drum kits

To assign a sound, stop the OP-Z sequencer, hold an iRig pad and play a note
on an OP-Z drum track (tracks 1-4). The pad is assigned that sound.
The pad's LED indicates its assigned track: yellow for kick (track 1),
red for snare (track 2), orange for hi-hats (track 3), and green for
samples (track 4).

Hold one or more pads to adjust their assigned channels. Use either button
as a modifier; buttons 1 and 2 are mutually exclusive.

| Held modifier | Pot 1 | Pot 2 | DATA turn | DATA push-turn | Fader |
| --- | --- | --- | --- | --- | --- |
| None | Pitch (CC 1) | HPF (CC 2) | LPF (CC 3) | LPF resonance (CC 4) | Pad maximum velocity |
| Button 1 | Sample start (CC 5) | Attack (CC 6) | Hold (CC 7) | Release (CC 8) | Compression (CC 9) |
| Button 2 | FX 1 (CC 13) | FX 2 (CC 14) | Pan (CC 15) | Level (CC 16) | Compression (CC 9) |

The CC numbers in the table identify the OP-Z parameters. The app sends
their relative-control equivalents. While a parameter control is moving,
the assigned note sounds repeatedly so you can hear the change; the
repetition stops when movement stops.

## Performance FX scenes

Each pad is either a note, a scene, or a custom slot. Its iRig LED is green
for a note, orange for a scene, and red for a custom slot. LEDs are normally
dim; pressing a pad brightens it according to pressure, and crossfading into
a scene brightens that scene's pad according to its crossfade depth.

### Assign a note

Stop the OP-Z sequencer, hold an iRig pad and play a note on the OP-Z to
assign that note to the pad.

### Add and edit parameter offsets

1. Hold a pad and quickly move an OP-Z parameter control in opposite
   directions to add that parameter to the pad's scene.
2. Turn the iRig **DATA encoder** to set the parameter's offset. The scene
   is applied at full depth while the offset is being set.
3. Click the DATA encoder to finalize the offset.

To remove a parameter, hold the pad and quickly move that OP-Z control in
opposite directions again. Outside offset editing, pad pressure controls
how much of the scene's offsets is applied.

### Crossfade scenes

Hold a pad and turn **pot 2** left to assign its scene to crossfader A
(bottom), or right to assign it to B (top). With no pad held, turn pot 2
left or right to clear the A or B assignment, respectively.

Move the iRig fader between A at the bottom and B at the top. Scene values
are offsets: when a parameter is present in both scenes, the fader blends
between their offsets. If it is present only in A, its offset fades from
full at A to zero at B; a B-only offset fades from zero at A to full at B.

Pad pressure blends a played pad's offsets with the crossfader state. At
maximum pressure the pad contributes fully and the crossfader contributes
nothing; at minimum pressure the crossfader state is used.

### Custom performance FX slots

The app provides 16 custom performance FX slots. Define each using a MIDI
channel, CC and value range. Minimum pad pressure sends the bottom of the
range; maximum pressure sends the top. Hold a pad and push-turn the DATA
encoder to switch between custom slots.

## Saving and loading

Save individual drum kits and performance FX scenes by name to the kit
library, and load them into scene slots. The mixer is fixed and cannot be
saved or loaded as an individual kit. Save and load the complete 16-scene
project as well.

The app keeps the kit library and current project in local storage. You can
also save each to disk and load it back, for backups or transfers. Keep
disk backups: browser storage can be cleared.

## Diagnostics

The app provides a view of OP-Z parameter values and their offsets. Select
a cell in the 16-by-16 OP-Z CC grid to see a recent history plot of that
CC before and after the offsets are applied. Grid values are purple when
offset and cyan otherwise; a legend identifies both states.
