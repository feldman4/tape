# OP-Z Pads implementation notes

This is a design-in-progress, not a description of current functionality.
The app implements an initial subset; see the status and setup in the manual.
User workflows belong in
[MANUAL.md](MANUAL.md).

## Controller and state

- Aim for a stateless controller: drive the iRig LEDs from the app's
  understanding of state, while accounting for the device's own scene
  switching. Its 16 scenes must share the same pad assignments: MIDI note 60, one
  channel per pad (1-16), **momentary**, not toggle. Momentary Note On/Off
  is needed to distinguish holding from releasing; the iRig manual says
  held pads send channel aftertouch.
- Users select scenes with the physical SCENE button, then move the fader
  so the app can detect the scene from its MIDI
  channel. Scene 1 is the mixer;
  slots 2-16 can be drum or performance FX. Display scene types and the
  current slot. The on-screen iRig depiction is read-only and shows the
  app's known fader position, pad and button press states, and LED colors
  and intensities. The hardware supports independent red and green LED
  intensity, allowing mixed colors and brightness.
- Establish and verify LED feedback and scene-change detection first.
  See [irig-pads.md](irig-pads.md) for the host-to-device LED CC pairs,
  channel 1 receive behavior. The scene-specific fader messages identify
  the scene; reconcile LEDs after detecting a switch, reconnecting or starting up.
- Specify non-pad control CCs and encoder mode consistently across iRig
  scenes. Only the fader channel identifies the scene; other controls accept
  any channel. Verify simultaneous
  holds, aftertouch and button gestures on hardware.

## MIDI routing and diagnostics

- Forward incoming OP-Z MIDI to the selected operating-system IAC output;
  Web MIDI does not create virtual ports. Mixer commands go to OP-Z, with
  level and pan changes also sent to IAC. Web MIDI SysEx access is not requested.
- Track OP-Z parameter values and offsets and expose a 16-by-16 CC grid.
  Color values purple when offset and cyan otherwise, with a legend.
  Clicking a cell plots recent pre- and post-offset values. Define the
  history window, sampling and exact grid mapping.
- Mixer button 1 plus DATA push syncs parameter state by selecting project 10,
  pattern 16, waiting 300 ms and setting CC 1-16 on all channels to 126.
  After another 300 ms, return to the last observed pattern if known; otherwise
  ask the user to select one. The calibration operation itself creates the
  required pattern values. This relies on switch timing rather than device
  confirmation; verify addressing, timing and feedback on hardware.
- OP-Z's [incoming MIDI table](https://teenage.engineering/guides/op-z/midi)
  specifies absolute parameter CCs 1-16 on tracks/channels 1-16, pan CC 15,
  volume CC 16, track mute CC 53 (values 0-1), and mute group CC 55 on any
  channel (values 0-9). Pads 1-10 select the ten mute groups; pads 11-16
  are unused for that gesture. The
  [OP-Z mixer guide](https://teenage.engineering/guides/op-z/mixer) describes
  groups as stored mute configurations, with the active group stored per
  pattern. Do not confuse OP-Z track mute with Ableton track mute.
- OP-Z MIDI settings can redirect channel 1 to the active track, disable
  MIDI or echo it; track channels and outgoing CC assignments are
  configurable. Document and validate the required settings and avoid
  feedback loops.

## Scene behavior

- Mixer pads target Ableton tracks. Pot 1/2 set absolute level/pan values on
  held pads; fader scales underlying levels only on the Ableton output, including
  forwarded OP-Z level changes. Button 1 toggles track
  mute and sends CC 120 (All Sound Off) on the
  corresponding virtual OP-Z channels toward Ableton, only when muting. While button 2 is held, pads 1-10 select a group and are dim
  orange, except the current group, which is bright orange; pads 11-16 are off.
  Pot movement displays level as green brightness or pan
  from red (left) to green (right), with unknown values off. A pot display
  started with pads held lasts until all pads are released. Otherwise, active pad LEDs are
  green through orange over the top half of the fader scale, then dim orange
  for active or unknown tracks, and off for muted tracks. The mixer overlays the final level
  on the gray underlying level. The fader requires a known underlying level;
  mute groups are tracked as changes are
  observed, assuming group 1 when the active group is not known.
- Drum pads learn notes from OP-Z tracks 1-4 and 13 while stopped. Pad LEDs identify
  assigned tracks: 1 yellow (kick), 2 red (snare), 3 orange (hi-hats),
  4 green (samples), and 13 green (performance FX). With pads held,
  the controls use the modifier table in the manual. Buttons 1 and 2 are
  exclusive: neither can be activated while the other is held. Send absolute
  parameter CCs to OP-Z and IAC. Pots and the compression fader use their
  positions; DATA adjusts the last observed or app-set value per channel and
  parameter, defaulting to 64 and clamping to 0-127. Button 1 or 2 plus
  fader adjusts compression (CC 9); without a button the fader changes the
  pad's maximum velocity. Send pad notes on channels 1-4 to both outputs and
  channel 13 pad notes only to OP-Z; repeat the assigned note
  while a parameter control is moving, stopping repetition when it stops.
  Verify drum parameter labels, CC assignments and audition timing on
  hardware.
- Performance FX pads learn notes while stopped. With a pad held, a rapid
  bidirectional OP-Z CC gesture adds or removes that parameter. DATA
  encoder sets its offset and a click finalizes it; the scene is at
  full depth during editing. A reversal within 500 ms of the prior movement
  toggles a CC 1–16 parameter on the latest held pad.
- Performance FX pad types are mutually exclusive: note LEDs are green,
  scene LEDs orange, and custom-slot LEDs red. Use low default brightness;
  increase a pressed pad's brightness with pressure and a crossfaded
  scene pad's brightness with its crossfade depth.
- Pot 2 assigns a held pad's scene to crossfader A (bottom) or B (top);
  with no pad held it clears the corresponding assignment. A gesture requires
  15 CC steps in one direction, restarting on reversal or a pad change. Each parameter
  blends between A and B offsets, treating an absent side as zero. For
  a pressed pad, pressure blends between that crossfader result and the
  pad's offsets: at maximum pressure the pad weight is 1 and crossfader
  weight is 0; at minimum the reverse. The latest held scene pad wins;
  results are clamped, require a known base, and restore known bases on release.
- Support 16 custom performance FX slots with channel, CC and value range.
  Pad aftertouch spans the range; holding a pad and push-turning DATA swaps
  slots. Custom values override offsets for the same CC; the latest held custom
  pad wins. FX CC output is sent only to Ableton. Definitions are browser-global.

## Persistence

Persist named drum kits and projects as independent snapshots in local storage,
alongside the automatically saved current project. The mixer is fixed, not a
saveable individual kit. Individual project and versioned kit files can be
downloaded from library entries or dropped onto their respective lists. Confirm replacements and deletions, validate stored and
imported data, and surface storage and import errors. Performance FX scenes
are saved in projects; separate performance FX kit libraries are not implemented.
