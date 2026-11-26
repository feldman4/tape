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
- Users select scenes with the physical SCENE button, then use a pot, fader,
  DATA control or button 1 or 2 so the app can detect the scene from its MIDI
  channel. Scene 1 is the mixer;
  slots 2-16 can be drum or performance FX. Display scene types and the
  current slot. The on-screen iRig depiction is read-only and shows the
  app's known fader position, pad and button press states, and LED colors
  and intensities. The hardware supports independent red and green LED
  intensity, allowing mixed colors and brightness.
- Establish and verify LED feedback and scene-change detection first.
  See [irig-pads.md](irig-pads.md) for the host-to-device LED CC pairs,
  channel 1 receive behavior. The scene-specific control messages identify
  the scene; reconcile LEDs after detecting a switch, reconnecting or starting up.
- Specify non-pad control CCs and encoder mode consistently across iRig
  scenes, with all controls on the scene's channel; verify simultaneous
  holds, aftertouch and button gestures on hardware.

## MIDI routing and diagnostics

- Forward incoming OP-Z MIDI to the selected operating-system IAC output;
  Web MIDI does not create virtual ports. Mixer commands go to OP-Z, with
  level and pan changes also sent to IAC. Web MIDI SysEx access is not requested.
- Track OP-Z parameter values and offsets and expose a 16-by-16 CC grid.
  Color values purple when offset and cyan otherwise, with a legend.
  Clicking a cell plots recent pre- and post-offset values. Define the
  history window, sampling and exact grid mapping.
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
  mute and sends CC 120 (All Sound Off) and CC 123 (All Notes Off) on the
  corresponding virtual OP-Z channels toward Ableton, both when muting and
  unmuting. While button 2 is held, pads 1-10 select a group and are dim
  orange, except the current group, which is bright orange; pads 11-16 are off.
  Pot movement displays level as green brightness or pan
  from red (left) to green (right), with unknown values off. A pot display
  started with pads held lasts until all pads are released. Otherwise, active pad LEDs are
  green through orange over the top half of the fader scale, then dim orange
  for active or unknown tracks, and off for muted tracks. The mixer overlays the final level
  on the gray underlying level. The fader requires a known underlying level;
  mute groups are tracked as changes are
  observed, assuming group 1 when the active group is not known.
- Drum pads learn notes from OP-Z tracks 1-4 while stopped. Pad LEDs identify
  assigned tracks: 1 yellow (kick), 2 red (snare), 3 orange (hi-hats),
  4 green (samples). With pads held,
  the controls use the modifier table in the manual. Buttons 1 and 2 are
  exclusive: neither can be activated while the other is held. Translate
  the table's parameter CCs to the OP-Z relative CCs (absolute CC + 31):
  send value 1 for increment and 127 for decrement. Button 1 or 2 plus
  fader adjusts compression (parameter CC 9 / relative CC 40); without a
  button the fader changes the pad's maximum velocity. Repeat the assigned note
  while a parameter control is moving, stopping repetition when it stops.
  Verify drum parameter labels, CC assignments and audition timing on
  hardware.
- Performance FX pads learn notes while stopped. With a pad held, a rapid
  bidirectional OP-Z CC gesture adds or removes that parameter. DATA
  encoder sets its offset and a click finalizes it; apply the scene at
  full depth during editing. Define gesture timing and behavior when
  multiple controls or pads are involved.
- Performance FX pad types are mutually exclusive: note LEDs are green,
  scene LEDs orange, and custom-slot LEDs red. Use low default brightness;
  increase a pressed pad's brightness with pressure and a crossfaded
  scene pad's brightness with its crossfade depth.
- Pot 2 assigns a held pad's scene to crossfader A (bottom) or B (top);
  with no pad held it clears the corresponding assignment. Each parameter
  blends between A and B offsets, treating an absent side as zero. For
  a pressed pad, pressure blends between that crossfader result and the
  pad's offsets: at maximum pressure the pad weight is 1 and crossfader
  weight is 0; at minimum the reverse. Define combination rules for
  multiple simultaneous pads, clamping, and restoration of base values.
- Support 16 custom performance FX slots with channel, CC and value range.
  Pad aftertouch spans the range; holding a pad and push-turning DATA swaps
  slots. Define interactions with regular offsets and simultaneous pads.

## Persistence

Persist named drum and performance FX kits and the current 16-slot project
in local storage. The mixer is fixed, not a saveable individual kit. Provide
separate disk save/load for the kit library and full project. Define file
formats, validation, versioning and collision/replacement behavior before
implementation; surface storage and import errors.
