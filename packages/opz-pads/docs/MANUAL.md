# OP-Z Pads manual

> **Implementation status:** This document describes the target design.
> The current first pass implements the controller display, scene types
> (empty and drum), drum note learning/playback and parameter control,
> project storage/import/export, and an incoming CC diagnostics grid.
> The mixer, performance FX, kit library and offset plotting below are not
> implemented. Do not rely on them yet.

## Current setup

Open the app in a Chromium browser on localhost or HTTPS. The app requests
MIDI access on load and selects available iRig Pads input and output ports,
including when the device is connected later. Grant browser MIDI permission
if prompted; use **Enable MIDI** to retry if access fails. In the Controller
view, select the OP-Z input and output and check the iRig selections; the
iRig and OP-Z inputs must be separate. Existing selections are not replaced
when another iRig appears. The app
sends drum notes and relative parameter CCs to the selected OP-Z output;
it does not currently forward OP-Z MIDI to Ableton or create virtual ports.
Use operating-system virtual MIDI ports and external routing if needed;
avoid routing the app's output back into its OP-Z input.

Program each iRig scene with momentary MIDI note 60,
one MIDI channel per pad. Program these controls on the MIDI channel matching
the scene number: pot 1 CC 94, pot 2
CC 95, fader CC 96, DATA encoder CC 92 in relative mode, and momentary
DATA push CC 93 (127 pressed, 0 released). Program momentary buttons 1 and 2
as CC 90 and CC 91, also on the scene's channel, with value 127 pressed and
0 released. Use the same CC assignments in every scene. Aftertouch, LED
feedback and the mappings still require hardware verification.

The iRig does not report scene selection directly. Startup assumes scene 1;
after selecting a scene on the device, move a pot, fader or DATA encoder, or
press or release DATA or button 1 or 2 to synchronize the app before playing
pads. The app detects the scene from that message's channel and processes the
control action normally.

Use **iRig check** for a guided bidirectional test. Choose any section from
the checklist; completed sections get a check mark. Progress is kept while
switching sections, but interrupted holds and gestures must be restarted.
Changing the scene resets all checks. It uses the same MIDI
port selections but needs only the iRig input and output. For one selected
scene it checks the scene-specific button message, each pad's note and aftertouch,
simultaneous holds, the configured controls, pad/modifier combinations, and
DATA push-turn. The LED check runs a roughly 10-second sequence through each
pad and buttons 1 and 2, from dim green through yellow to dim red. Confirm the
sequence visually once it finishes. Repeat
the check for each programmed scene; a pass does not verify other scenes or
automatically detect what the LEDs displayed. The last raw MIDI message is
shown to help diagnose mismatches. While checking, normal scene input and
OP-Z input are suspended. On leaving, select a scene on the iRig and use a
scene-specific control to resynchronize; the OP-Z transport state must also
be received again.

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
(up to 100 per CC); values are unknown until received, and offsets are
not implemented.

OP-Z Pads uses an iRig Pads controller alongside an OP-Z and Ableton Live.
Use the iRig's pads, pots, buttons, DATA encoder and fader to control a
mixer, play drum kits and shape performance effects. The app displays the
controller and its state; its on-screen pads and controls are for viewing,
not for operating the hardware. The controller view shows the iRig layout,
including the app's understanding of the fader position, pad and button
presses, and LED colors and brightness.

## Scenes and projects

A project contains 16 scene slots. Scene 1 is always the mixer. Slots 2-16
can contain drum kits or performance FX scenes. Select a scene using the
iRig's **SCENE** button and the corresponding pad, then use a scene-specific
control to tell the app which scene is active. The app shows its last detected
scene and the 16 slots, with colors or icons identifying their types.
The iRig's pad LEDs reflect the state known to the app.

The iRig must use the same pad setup in every scene: each pad sends note 60 in
momentary mode, on its own MIDI channel from 1 through 16. See the
[iRig Pads reference](irig-pads.md) for the device's scene-editing
controls.

## Mixer: scene 1

The 16 pads correspond to tracks in Ableton Live.
In this scene, active pad LEDs are green and inactive pad LEDs are dark.
The mixer view shows one level bar per track and a 10-by-16 mute-group
matrix using filled and hollow dots. Track colors are cyan for tracks 1-4,
green for 5-8, purple for 9-12 and orange for 13-16.

- Hold one or more pads and turn **pot 1** to offset their levels, or
  **pot 2** to offset their pan.
- Hold one or more pads and move the **fader** to scale their volume as a
  fraction of their underlying levels.
- Hold **button 1** and tap pads to mute or unmute the corresponding tracks.
  This also stops sounding notes on those tracks in Ableton Live.
- Hold **button 2** and tap pads 1-10 to select OP-Z mute groups 1-10.
  Pads 11-16 do not select a mute group. OP-Z mute groups store different
  track mute configurations.
- With no pads held, turn pot 1 or pot 2 to show the current track levels or
  pan positions, respectively, on the LEDs.

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
