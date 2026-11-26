# OP-Z Pads manual

OP-Z Pads uses an iRig Pads controller alongside an OP-Z and Ableton Live.
Use the iRig's pads, pots, buttons, DATA encoder and fader to control a
mixer, play drum kits and shape performance effects. The app displays the
controller and its state; the on-screen controller is for viewing, not for
operating the hardware.

For device setup, see [iRig Pads and OP-Z setup](device-setup.md).

## Navigation

Keys **1–4** open Scene, Project, OP-Z and iRig MIDI respectively.

App pads and scenes are numbered left to right from the top left. The iRig
labels them from the bottom left: physical pad 13 corresponds to app pad 1,
and physical pad 1 to app pad 13. The iRig MIDI check uses physical labels.

## Scenes and projects

A project contains 16 scene slots, shown on the Project page. Scene 1 is
always the mixer; slots 2–16 can contain drum kits or performance FX scenes.
Choose a slot's type on the Project page. Changing its type replaces its
contents.

Select a scene using the iRig's **SCENE** button and the corresponding pad,
then move the fader to tell the app which scene is active. The Project page
shows the last detected scene and identifies the slot types. The Scene page
shows the active scene, or an empty state for an unconfigured slot. The iRig's
pad LEDs reflect the state known to the app.

## Mixer: scene 1

The 16 pads correspond to OP-Z tracks and MIDI channels 1–16. Active and
unknown pad LEDs show each track's fader scale: bright green means no
reduction, shifting to orange by half scale and dimming to faint orange at
zero. Muted pads are dark; active pads remain lit even at zero.

The mixer view shows a gray underlying level bar per track, overlaid by a
colored bar for its final level after fader scaling, and a 10-by-16 mute-group
matrix using filled and hollow dots. Track colors are cyan for tracks 1–4,
green for 5–8, purple for 9–12 and orange for 13–16. Controller status shows
whether iRig buttons 1 and 2 are held.

### Mixer controls

- Hold one or more pads and turn **pot 1** to set their levels, or
  **pot 2** to set their pan, directly from the pot position.
- Hold one or more pads and move the **fader** to scale their volume on the
  Ableton output as a fraction of their underlying OP-Z levels.
- Hold **button 1** and tap pads to mute or unmute the corresponding tracks.
  This also stops sounding notes on those tracks in Ableton Live.
- While OP-Z is playing, press **DATA** to guess the current group's mute
  states from incoming MIDI channel activity. Tracks that transmitted within
  the last eight seconds of the current playback are marked active; the rest
  are marked muted. This only changes the app's display, not OP-Z's mutes.
  Sparse tracks or MIDI configuration can make the guess inaccurate.
- Hold **button 2** and tap pads 1-10 to select OP-Z mute groups 1-10.
  While held, the current group's pad is bright orange and the other group
  pads are dim orange. Pads 11-16 are off and do not select a mute group.
  Releasing the button restores the track display. OP-Z mute groups store
  different track mute configurations.
- Turn pot 1 to show track levels as green LED brightness, or pot 2 to show
  pan positions as a gradient from red (left) to green (right), whether or not
  pads are held. Unknown values stay dark. In the level display, known zero
  values use minimum brightness for active or unknown tracks and stay dark
  for muted tracks.
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

### Mute state

Track mutes start unknown, and the active mute group is assumed to be group 1
until another group is selected or reported. If a track's mute state is
unknown, the first button-1 toggle assumes it is unmuted and sends mute.
Muting a track also sends All Sound Off (CC 120) on
that track's channel to the Ableton output; unmuting does not. The matrix shows mute states
received, changed or guessed for the selected or assumed group; other cells
remain unknown. Group observations are cleared and group 1 is assumed again on
incoming pattern changes and OP-Z input reconnection. OP-Z MIDI does not
provide a complete mute-group readback, so external changes may leave the
display incomplete or stale.

### Sync OP-Z parameters

Hold **button 1** and press **DATA** to sync parameter state. The app selects
project 10, pattern 16, waits 300 ms, and sets CCs 1–16 on all channels to
126. After another 300 ms it returns to the last observed OP-Z pattern, if
known; otherwise, select a working pattern yourself. The OP-Z should send
changed values when the working pattern loads; values equal to 126 are
already known. This gesture does not guess mutes.

The reserved pattern's parameter values are overwritten. Avoid changing
patterns during sync. Switch timing and OP-Z feedback require hardware
verification; a successful MIDI send does not confirm that the device
switched. See the [setup guide](device-setup.md) for sync requirements.

## Drum kits

Select a drum kit scene on the iRig and move the fader. To assign a sound,
stop the OP-Z sequencer, hold an iRig pad and play a note on an OP-Z drum
track (tracks 1–4) or performance FX track (track 13). Learning is enabled
only after an OP-Z MIDI Stop message; Start or Continue disables it again.
Reassigning a pad keeps its maximum velocity; new assignments start at 127.
The pad's LED indicates its assigned track: yellow for kick (track 1),
red for snare (track 2), orange for hi-hats (track 3), and green for samples
(track 4) and performance FX (track 13).

The corresponding card outline flashes when you hit an iRig pad. Its dark
gray velocity bar shows the maximum, with no background track beyond it. A
played note overlays its velocity in the pad's track color for at least 250 ms,
or while the note sounds if longer.

Hold one or more pads to adjust their assigned channels. Use either button
as a modifier; buttons 1 and 2 are mutually exclusive.

| Held modifier | Pot 1 | Pot 2 | DATA turn | DATA push-turn | Fader |
| --- | --- | --- | --- | --- | --- |
| None | Pitch (CC 1) | HPF (CC 2) | LPF (CC 3) | LPF resonance (CC 4) | Pad maximum velocity |
| Button 1 | Sample start (CC 5) | Attack (CC 6) | Hold (CC 7) | Release (CC 8) | Compression (CC 9) |
| Button 2 | FX 1 (CC 13) | FX 2 (CC 14) | Pan (CC 15) | Level (CC 16) | Compression (CC 9) |

The app sends these absolute CCs to both OP-Z and Ableton, including for
performance FX pads; the parameter names in the table describe drum tracks.
DATA uses signed relative movements to adjust the latest observed or app-set
value for each channel and parameter, starting at 64 when unknown and
clamping to 0–127. The OP-Z must send its
parameter values using the CC numbers in the table for them to be observed.
Pad notes on channels 1–4, including audition repeats and note-offs, go to both
outputs. Channel 13 pad notes go only to OP-Z. MIDI received from OP-Z is
still forwarded to Ableton, including channel 13.
While a parameter control or the maximum velocity fader is moving, the
assigned note repeats every 120 ms so you can hear the change. Repetition
stops 200 ms after the last movement or when the pad is released.

## Performance FX scenes

Each pad is either a note, a scene, or a custom slot. Its iRig LED is green
for a note, orange for a scene, and red for a custom slot. LEDs are normally
dim; pressing a pad brightens it according to pressure, and crossfading into
a scene brightens that scene's pad according to its crossfade depth.
Unassigned pads are dark. Assignments are exclusive: assigning a different
type replaces the previous one.
The Scene view shows each scene pad's current blend depth and each custom
pad's pressure as horizontal bars. The iRig-style controls to the left of the
pads show the fader position and A (bottom) and B (top) assignments.
The fader spans the bottom two pad rows. Scene depth is the pad's blend
weight; individual parameters may still be overridden by custom slots or
lack a known base. Pot markers show their last received positions and are
absent until the pots are moved.

### Assign a note

Stop the OP-Z sequencer, hold an iRig pad and play a note on the OP-Z to
assign that note to the pad. As with drum kits, the app must receive a MIDI
Stop before learning; Start or Continue disables learning. Pad notes go to
OP-Z and Ableton, except channel 13 notes, which go only to OP-Z.

### Add and edit parameter offsets

1. Hold a pad and quickly move an OP-Z parameter control in opposite
   directions to add that parameter to the pad's scene.
2. Turn the iRig **DATA encoder** to set the parameter's offset. The scene
   is applied at full depth while the offset is being set.
3. Click the DATA encoder to finalize the offset.

To remove a parameter, hold the pad and quickly move that OP-Z control in
opposite directions again. Outside offset editing, pad pressure controls
how much of the scene's offsets is applied. The reversal must occur within
500 ms of the preceding movement. Only CCs 1–16 are learned. The most
recently held pad is the target of learning and editing; releasing it ends
editing. The original OP-Z parameter remains unchanged by scene offsets.

### Crossfade scenes

Hold a pad and turn **pot 2** left to assign its scene to crossfader A
(bottom), or right to assign it to B (top). With no pad held, turn pot 2
left or right to clear the A or B assignment, respectively. Move at least
15 CC values continuously in that direction; reversing direction or changing
which pads are held starts a new gesture. If the pot's position is unknown,
the first received value establishes the starting point.

Move the iRig fader between A at the bottom and B at the top. Scene values
are offsets: when a parameter is present in both scenes, the fader blends
between their offsets. If it is present only in A, its offset fades from
full at A to zero at B; a B-only offset fades from zero at A to full at B.

Pad pressure blends a played pad's offsets with the crossfader state. At
maximum pressure the pad contributes fully and the crossfader contributes
nothing; at minimum pressure the crossfader state is used. If several scene
pads are held, the most recently pressed scene pad controls the blend; releasing
it returns control to the previous one. Offsets are added to the latest known
base value, rounded and clamped to 0–127. The app waits for an OP-Z value or
an app-set parameter value before applying an offset, and restores known base
values when an effect ends or the scene changes. CC 16 is then scaled by the
mixer fader. Calculated FX CCs go only to Ableton, not OP-Z.

### Custom performance FX slots

The app provides 16 shared custom performance FX slots. Define each on the
performance FX Scene page using a MIDI channel, CC and value range, then save
it. Slots initially use channel 13, CC 1 and range 0–127. Minimum pad pressure
sends the first value; maximum pressure sends the second, so reversed ranges
are allowed. Hold a pad and push-turn the DATA encoder to assign or switch
slots. Custom CCs go only to Ableton. If held custom pads target the same CC,
the most recently pressed wins; custom values override scene offsets on that
CC. On release the app restores the scene value or the last known base; if no
base was received, it cannot restore that CC. Custom slot definitions are
stored in the browser independently of projects and are not included in
project exports.

## Saving and loading

On the Project page, name and save the current 16-scene project or current
drum kit in the corresponding library. Click a name to load it, or its X to
delete it. A kit loads into the current scene, including an empty scene; drag a
kit name onto a scene slot to load it there instead. The mixer cannot be
replaced. Dropping a kit replaces the target without confirmation. Init project
starts a new project; Init kit replaces the current non-mixer scene with an
empty drum kit. Saving over an existing name replaces it without confirmation;
other replacements and deletions require confirmation. Names are trimmed and case-sensitive. Library entries
are snapshots: subsequent edits to the current project do not change a saved
entry until it is saved again.

Use the download icon beside a saved entry to export it as `project_<name>.json`
or `kit_<name>.json`. Spaces are preserved; characters not usable in filenames
are percent-escaped. Drag project or kit files onto the corresponding library
to import them under the filename, without its extension and, for exported
files, its type prefix. Files are versioned and validated; importing does not
change the current project or scene. Project and kit files must use version 2.
An invalid or unsupported stored library is cleared and replaced with an empty
library; the working project and other browser storage are not cleared.
Importing over an existing library name requires confirmation. The working project
and libraries are stored in the browser; keep disk backups because browser
storage can be cleared. There is no separate performance FX kit library; FX
scenes are saved as part of projects.

## OP-Z diagnostics

The OP-Z page shows the last project and pattern observed from OP-Z MIDI, or
`—` when unknown. This is not device confirmation of a pattern switch requested
by the app, and the observation is cleared when OP-Z input is reset.
The page also shows parameter values and their offsets. Select a cell in the
16-by-16 CC grid to see the last 10 seconds of input and calculated output
after effects and mixer scaling, up to 100 entries per CC. Input values are
unknown until received or established by parameter sync. Grid values are
purple when the last calculated output differs from the input and cyan
otherwise. A purple cell shows the input followed by the signed difference
from the last calculated output (for example, `100-20`). This reflects
clamping, custom values and mixer scaling as well as scene offsets. Scroll
the grid horizontally when it does not fit on screen.

## iRig MIDI check

The iRig MIDI page shows the controller beside a guided check, including
received fader, pad and button input. Pot markers show their last received
positions and are absent until moved. Pad colors show the last scene state,
not the LED test pattern. Normal scene processing is suspended on this page.
See the [setup guide](device-setup.md) for the check procedure.

Choose **LED colors** to explore the app's LED palette or select a gradient and
move its slider. Choose a physical pad (1–16) or button (1–2), then press
**Send color**. The red and green values are MIDI intensities from 0 to 127;
the screen preview is approximate. Sent colors remain until changed or you
leave the explorer, which restores scene pad LEDs and turns tested buttons off.
The explorer is optional and does not affect check completion.

## LED log

On the OP-Z and iRig MIDI pages, press **~** (or the unshifted backtick key)
to show or hide the bottom gutter. It is hidden by default and logs the last
100 pad LED color messages sent to the iRig, including failed attempts, even
while hidden. A successful send does not confirm that the LED changed.
