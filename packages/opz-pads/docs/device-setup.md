# iRig Pads and OP-Z setup

Open the app in a Chromium browser on localhost or HTTPS. The app requests
MIDI access on load and selects available iRig Pads and OP-Z input and output
ports, and the IAC Driver Bus 1 output, including when they are connected later. Grant browser MIDI
permission if prompted; use **Enable MIDI** to retry if access fails. In the
Controller view, check the iRig, OP-Z and Ableton output selections; the iRig and OP-Z inputs
must be separate. Existing selections are not replaced when another device
appears. Create and enable **IAC Driver Bus 1** in macOS Audio MIDI Setup;
the browser cannot create virtual MIDI ports. Enable that bus as a MIDI input
in Ableton Live. The app forwards OP-Z MIDI received by Web MIDI to that bus
and sends mixer level and pan changes there as well as to OP-Z. It sends drum
notes and relative drum parameter CCs to OP-Z. The app does not request
system-exclusive access, so SysEx is not forwarded.

Enable OP-Z incoming and outgoing MIDI, set track channels 1–16 and outgoing
pan/volume CCs 15/16, disable channel-one-to-active and MIDI echo, and avoid
routing the IAC bus or Ableton output back to the OP-Z input. These settings
and the OP-Z's actual feedback behavior need hardware verification.

Program each iRig scene with momentary MIDI note 60,
one MIDI channel per pad from 1 through 16. Program these controls on the MIDI channel matching
the scene number: pot 1 CC 94, pot 2
CC 95, fader CC 96, DATA encoder CC 92 in relative mode, and momentary
DATA push CC 93 (127 pressed, 0 released). Program momentary buttons 1 and 2
as CC 90 and CC 91, also on the scene's channel, with value 127 pressed and
0 released. Use the same CC assignments in every scene. Aftertouch, LED
feedback and the mappings still require hardware verification. See the
[iRig Pads reference](irig-pads.md) for the device's scene-editing controls.

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
OP-Z input processing are suspended, although OP-Z MIDI is still forwarded
to Ableton. On leaving, select a scene on the iRig and use a
scene-specific control to resynchronize; the OP-Z transport state must also
be received again, mixer values and mute-group observations start unknown,
and the active mute group is assumed to be group 1.
