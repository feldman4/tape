# iRig Pads and OP-Z setup

Open the app in a Chromium browser on localhost or HTTPS. The app requests
MIDI access on load and selects available iRig Pads and OP-Z input and output
ports, and the IAC Driver Bus 1 output, including when they are connected later. Grant browser MIDI
permission if prompted; use **Enable MIDI** to retry if access fails. In the
iRig MIDI page, check the iRig, OP-Z and Ableton output selections; the iRig and OP-Z inputs
must be separate. Existing selections are not replaced when another device
appears. Create and enable **IAC Driver Bus 1** in macOS Audio MIDI Setup;
the browser cannot create virtual MIDI ports. Enable that bus as a MIDI input
in Ableton Live. The app forwards OP-Z MIDI received by Web MIDI to that bus
and sends mixer level and pan changes there as well as to OP-Z. It sends drum
pad notes on channels 1–4 and absolute drum parameter CCs to both outputs;
channel 13 pad notes go only to OP-Z. Drum level CCs are
scaled on the Ableton output by the mixer fader. Performance FX scene offsets
and custom CCs go only to Ableton; FX note pads go to both outputs except
channel 13 notes, which go only to OP-Z. The app does not request
system-exclusive access, so SysEx is not forwarded.

Enable OP-Z incoming and outgoing MIDI, set track channels 1–16 and outgoing
pan/volume CCs 15/16, disable channel-one-to-active and MIDI echo, and avoid
routing the IAC bus or Ableton output back to the OP-Z input. These settings
and the OP-Z's actual feedback behavior need hardware verification.
For parameter-state sync, enable program change in/out and configure outgoing
parameter CCs 1–16 on tracks 1–16 to
match their incoming CC numbers. Reserve project 10, pattern 16 for calibration.
The sync relies on a 300 ms switch delay, not device confirmation.

The app reads and sends pattern program changes using MIDI channel 1–10 as
the project and raw program value 0–15 as pattern 1–16. For example, project 8
pattern 6 is `C7 05`, and project 10 pattern 16 is `C9 0F` (hexadecimal).
The [OP-Z MIDI guide](https://teenage.engineering/guides/op-z/midi) also
describes a different program-change mapping; verify that the OP-Z responds
to the requested switches before relying on parameter sync.

Program each iRig scene with momentary MIDI note 60,
one MIDI channel per pad matching its physical iRig label from 1 through 16
(pad 1 is at the bottom left). The app numbers pads from the top left:
physical pad 13 is app pad 1 and physical pad 1 is app pad 13.
Program fader CC 96 on the MIDI channel matching the physical iRig scene
number. The same row reversal applies to scene selection: physical scene 13
selects app scene 1 (the mixer), and physical scene 1 selects app scene 13.
Program pot 1 CC 94, pot 2
CC 95, DATA encoder CC 92 in relative mode, and momentary
DATA push CC 93 (127 pressed, 0 released). Program momentary buttons 1 and 2
as CC 90 and CC 91, with value 127 pressed and 0 released. The app accepts
these non-fader CCs on any channel. Use the same CC assignments in every scene. Aftertouch, LED
feedback and the mappings still require hardware verification. See the
[iRig Pads reference](irig-pads.md) for the device's scene-editing controls.

The iRig does not report scene selection directly. Startup assumes scene 1;
after selecting a scene on the device, move the fader to synchronize the app
before playing pads or using other controls. The app detects the scene from
the fader message's channel and processes the fader action normally.

Use the guided bidirectional check on **iRig MIDI**. Choose any section from
the checklist; completed sections get a check mark. Progress is kept while
switching sections, but interrupted holds and gestures must be restarted.
Changing the scene resets all checks. It uses the same MIDI
port selections but needs only the iRig input and output. For one selected
scene it checks the scene-specific fader message, each pad's note and aftertouch,
simultaneous holds, the configured controls, pad/modifier combinations, and
DATA push-turn. The LED check runs a roughly 10-second sequence through each
pad and buttons 1 and 2, from dim green through yellow to dim red. Confirm the
sequence visually once it finishes. Repeat
the check for each programmed scene; a pass does not verify other scenes or
automatically detect what the LEDs displayed. The last raw MIDI message is
shown to help diagnose mismatches. While checking, normal scene input and
OP-Z input processing are suspended while the iRig MIDI page is open, although
OP-Z MIDI is still forwarded to Ableton. On leaving, select a scene on the iRig and move the
fader to resynchronize; the OP-Z transport state must also
be received again, mixer values and mute-group observations start unknown,
and the active mute group is assumed to be group 1.

The optional **LED colors** section lets you send palette colors or a position
on an app gradient to a physical pad or button. Leaving it restores scene pad
LEDs and turns tested buttons off; it is not part of the pass criteria.
