# 16-Slot MIDI Sampler

## Purpose

The sampler records and plays 16 audio clips from MIDI notes. It is designed for an OP-Z-led setup and runs in a Chromium browser on macOS.

## Setup

1. Connect the OP-Z and audio interface.
2. Open the sampler in Chrome or Edge.
3. Allow microphone and MIDI access when prompted.
4. In the configuration panel, select the audio and MIDI devices and stereo channel pairs.
5. Set the **MIDI Channel**, **First Sample Note**, **Delete Note**, **Count-in On Note**, **Count-in Off Note**, **Channel Switch Note**, **Take Mode Note**, and **One-shot Mode Note**. The notes must not overlap.
6. Assign the four per-slot mixer CCs: **HPF Cutoff**, **LPF Cutoff**, **Pan**, and **Level** (CC 1–4 by default), plus **Master Level** (CC 16 by default).
7. Select **Project 1–10** from the project dropdown.

The app remembers device, channel-pair, and project selections in browser storage. It reconnects devices by name, restores available channel pairs, and opens the last selected project. Unavailable selections use their defaults until they become available or another selection is made.

## Sample notes

The **First Sample Note** begins one contiguous range of 16 notes. For example, if it is C2, the slots use C2 through D#3. Each note always controls the same slot. Normally, only notes on the configured MIDI channel are accepted, and MIDI
velocity does not change recording or playback level. In Channel Mode, the same
16-note range is available independently on the Channel A and Channel B MIDI
channels.

Every received Note On in the 16-note sample range briefly flashes the
corresponding slot outline in muted gray, including when the note does not
change the slot (for example, an empty slot while stopped).

| Slot state | Sequencer state | Note On | Note Off |
| --- | --- | --- | --- |
| Empty, idle | Running | Start recording | Do nothing |
| Empty, idle | Stopped | Do nothing | Do nothing |
| Empty, recording | Any | Do nothing while the original note is held; during the recording tail, play the capture so far while recording continues | Stop recording and store the sample |
| Sample loaded, stopped | Any | Start playback from the beginning | Do nothing |
| Sample loaded, playing | Any | Restart playback from the beginning | Stop playback |

Recording begins immediately. After Note Off, recording continues for the configurable recording-tail period (300 ms by default). If the next pattern cycle triggers that slot before the tail has finished, it plays the captured portion immediately while the tail continues recording. Playback fades the final recording-tail period to silence. When the same slot is retriggered before its playback ends, the outgoing playback fades out over the recording-tail period while the new playback starts from the beginning, crossfading the tail into the new attack. A slot records the selected audio input. Samples are one-shots and can overlap, so triggering other slots does not stop recording or playback. Stopping the sequencer stops all playback immediately.

## One-shot and Take modes

**One-shot** is the default recording mode. A completed recording immediately
becomes the slot's playable sample, as described above.

Send the configured **Take Mode Note** to enter **Take** mode. Send the
**One-shot Mode Note** to switch back to One-shot mode.

The front panel displays the active recording mode beside the Count-in status.

### Take-mode workflow

1. Enter Take mode, then trigger an **empty** slot while the sequencer is
   running. This begins the first take.
2. Each subsequent sequencer pass for that slot finishes the preceding take
   and immediately begins the next one. The slot remains an unfinalized take.
3. Send the Take Mode Note again to finalize the preceding completed take
   (unless there is none, in which case it finalizes the current take). The
   finalized take's ring changes from amber to blue and it immediately starts
   playing from that point. Later sequencer passes play its sample instead of
   recording over it.

Take sequences can begin only from an empty slot. While the sequencer is
running, triggering a completed unfinalized take begins the next take;
triggering a slot while its current take is recording does nothing. Triggering
a finalized slot plays it. When the sequencer is stopped, either type of loaded
slot plays its latest complete take. An unfinalized take has an amber slot ring;
finalized samples use blue and recording slots use red.

When the sequencer is paused, triggering a slot plays its latest complete take,
even if it is not finalized. If the sequencer stops in the middle of recording
a take, that in-progress take is discarded, unless it is the first take
recorded for an empty slot.

Selecting a different slot discards any unfinalized take in the previously
selected slot.

## Channel Mode

Enable **Channel Mode** in the configuration panel to use two independent
16-slot banks. Channel A and Channel B use the same **First Sample Note**
range, but each bank is triggered from its own MIDI channel. By default,
Channel A uses MIDI channel 15 and Channel B uses MIDI channel 16.

Sample notes on Channel A record and play only Channel A; sample notes on
Channel B record and play only Channel B. The applicable control notes,
including Delete, Count-in, and the One-shot and Take mode notes, are accepted
on either bank channel. The **Channel Switch Note** selects the bank mapped to
the MIDI channel that sends it, clears the selection, and cancels any pending
Delete Note pairing. When selecting or recording a sample in either bank, the front panel
automatically switches to that bank so its samples are shown.

Channel Mode disables the per-slot **Level**, **Pan**, **LPF Cutoff**, and
**HPF Cutoff** controls. Playback from Channel A is panned hard left and
playback from Channel B is panned hard right.

The selected audio input is monitored live through the speakers, panned hard to
the active channel's side.

## Selected sample

The selected sample receives the four per-slot mixer CCs and is outlined in thin yellow on the front panel. There is no selection when the app starts or after a project change. The following table lists the only actions that change the selection:

| Action | Sequencer state | Effect on selected sample |
| --- | --- | --- |
| Finish recording a slot | Any | Selects the recorded slot. |
| Trigger a loaded slot | Stopped | Selects the triggered slot. |
| Delete the selected slot | Any | Clears the selection. |
| Send a standalone Delete Note | Running | Deletes and clears the selected slot after 500 ms; if no slot is selected, it has no effect. |
| Send the Channel Switch Note | Any | Clears the selection (Channel Mode only). |
| Switch projects | Any | Clears the selection. |
| Clear Project Memory | Any | Clears the selection. |

## Deleting a sample

There is one global **Delete Note**.

1. Trigger a slot's sample note.
2. Trigger the Delete Note within 500 ms.

That slot is cleared. Repeat the same delete gesture for that slot to restore the deleted sample and its mixer settings. The two notes may arrive in either order, provided they are no more than 500 ms apart. Deleting a recording cancels it; deleting a playing sample stops it. When the sequencer is stopped, a Delete Note outside the 500 ms window does nothing.

When the sequencer is running, a Delete Note by itself deletes the selected slot after the 500 ms pairing window. Starting playback while the sequencer is running does not change the selection, so a standalone Delete Note can undo the last recording.

Choose a Delete Note outside the 16-note sample range.

## Mixing

Each slot has four controls:

- **Level** — from silence to full level.
- **Pan** — from fully left through center to fully right.
- **LPF Cutoff** — lowers the low-pass cutoff as the CC value decreases.
- **HPF Cutoff** — raises the high-pass cutoff as the CC value increases.

The four per-slot CC assignments control the **selected slot**. The global **Master Level CC** controls the final playback level without requiring a selected slot.

CCs are accepted only on the configured MIDI channel. Until a slot is selected, mixer CCs do nothing. The filters have no resonance control. Filter slope and other advanced filter behavior are global settings in the configuration panel.

## Projects

Use the project dropdown to select **Project 1–10**. Each project stores its
16 samples and all per-sample mixer settings, or both 16-slot banks when
Channel Mode is enabled. Changes are saved automatically in the browser.

**Initialize** permanently replaces the selected project with an empty project. It does not affect the other nine projects or app settings.

Project playback and recording stop when switching projects. Device selections, MIDI and CC assignments, recording-mode and Channel Mode settings, count-in settings, recording latency compensation, and global filter configuration are app settings and do not change with the project.

Browser storage belongs to the current browser profile and site. Clearing site data removes all projects, so use **Download Projects** for backup or transfer.

If the app reports that a locally stored project is invalid, select **Clear Project Memory** from the error screen or configuration panel.

### Download and restore

**Download Projects** produces one ZIP containing exactly ten extensionless files:

`project-01`, `project-02`, …, `project-10`

To restore projects, upload that ZIP. The app restores each valid top-level file whose name exactly matches `project-01` through `project-10`. Matching projects are overwritten; missing projects are left unchanged; other files are ignored.

To restore one project, upload a single project file. Its contents overwrite the currently selected project regardless of its filename. Restoration takes effect immediately and cannot be undone except by restoring another backup.

## Display

The app name appears in the browser tab, not on the front panel. The panel contains 16 circular waveforms in note order, left to right and top to bottom. Their heights are peak-normalized for display, with a fixed floor that keeps near-silent recordings visibly small. Four tiny knobs beside each waveform display Level, Pan, LPF Cutoff, and HPF Cutoff. The circles and knobs are displays, not mouse controls.

A narrow stereo input level meter runs down the left edge of the screen, showing the live L/R input signal (independent of any slot's recording/playback state). Each column is green under normal levels, orange as it approaches saturation, and red at/near saturation.

A matching stereo master meter runs down the right edge, showing the post-master playback signal. Its thin gray horizontal line indicates the current master level.

Their appearance shows each slot's state:

- Empty: no waveform.
- Recording: live recording progress.
- Ready: the stored waveform.
- Playing: playback progress over the waveform.
- Delete: the circle returns to empty.

## Count-in

The OP-Z has no built-in count-in for recording, so **Count-in** stops it, counts the configured beats, then restarts it. It affects transport start only and does not delay an individual sample recording. Once the BPM indicator has a value, the front-panel **Count-in** button manually runs the same Stop, count, and Start procedure. The app plays an audible click for each count-in beat through the selected audio output.

Send a Note On for the **Count-in On Note** on the configured MIDI channel to enable Count-in, or the **Count-in Off Note** to disable it. Its state is displayed on the front panel and cannot be changed there.

When Count-in is off, OP-Z Start passes through normally. When it is on:

1. The app receives OP-Z Start.
2. It immediately sends Stop.
3. It counts the configured number of beats using the most recently measured MIDI Clock tempo. If MIDI Clock continues while stopped, its pulses complete the count instead.
4. It sends Start to the OP-Z.

Set **Count-in Beats** to the desired length. The app derives tempo from MIDI clock; the OP-Z remains clock master. Count-in requires both MIDI input and MIDI output to be connected to the OP-Z.

The BPM indicator shows the tempo estimated from recent MIDI Clock pulses. It reads **?** until enough clock has arrived to estimate reliably, and again after MIDI Clock stops arriving (transport stopped, cable disconnected, etc.) instead of showing a stale number.

## Configuration panel

Select the gear button on the front panel to open the configuration panel. It contains device selection, numeric MIDI assignments, a filter-slope selector, and **Clear Project Memory**. Project selection, download, restore, MIDI Clock state, BPM, and Count-in state remain on the front panel.

| Option | Function | Default |
| --- | --- | --- |
| Audio Input | Selects the signal recorded into slots; its device name is remembered and reconnected automatically. | — |
| Input Channels | Selects the stereo pair from the audio input recorded into each sample; the last selected pair is restored when available. | 1–2 |
| Audio Output | Selects where sample playback is sent; its device name is remembered and reconnected automatically. | System default |
| Output Channels | Selects the stereo output pair for sample playback when the device exposes multiple pairs; the last selected pair is restored when available. | 1–2 |
| MIDI Input | Selects the source of notes, clock, and transport; its device name is remembered and reconnected automatically. | — |
| MIDI Output | Selects the destination for Stop and Start during count-in; its device name is remembered and reconnected automatically. | — |
| MIDI Channel | Sets the channel used by sample notes, control notes, and mixer CCs when Channel Mode is off. | 16 |
| Channel Mode | See [Channel Mode](#channel-mode). | Off |
| Channel A MIDI Channel | Sets the MIDI channel that triggers Channel A while Channel Mode is on. | 15 |
| Channel B MIDI Channel | Sets the MIDI channel that triggers Channel B while Channel Mode is on. | 16 |
| First Sample Note | Sets the first note in the 16-note slot range. | 53 (F3) |
| Delete Note | Sets the note used with a slot note to clear that slot. | 75 |
| Count-in On Note | Sets the note that enables Count-in. | 72 |
| Count-in Off Note | Sets the note that disables Count-in. | 71 |
| Channel Switch Note | In Channel Mode, selects the channel (bank) mapped to the MIDI channel that sends it; ignored when Channel Mode is off. | 73 |
| Take Mode Note | Sends Tape into Take mode; sending it again finalizes the preceding completed take, or the active take when there is no preceding take. | 76 |
| One-shot Mode Note | Switches recording back to One-shot mode. | 74 |
| HPF Cutoff CC | Sets the global CC number used for the selected slot's high-pass cutoff. | 1 |
| LPF Cutoff CC | Sets the global CC number used for the selected slot's low-pass cutoff. | 2 |
| Pan CC | Sets the global CC number used for the selected slot's pan. | 3 |
| Level CC | Sets the global CC number used for the selected slot's level. | 4 |
| Master Level CC | Sets the global CC number used for final playback level. | 16 |
| Count-in Beats | Sets the number of beats before transport restarts while Count-in is on. | 4 |
| Recording Tail | Continues recording after Note Off and sets the playback fade and same-slot retrigger crossfade duration. | 300 ms |
| Recording Latency | Skips this amount from the start of every sample when it is triggered, compensating for recording latency without modifying the stored sample. Changes apply to the next trigger. | 20 ms |
| Filter Slope | Sets the global LPF and HPF slope in the configuration panel. | 24 dB/oct |
| Clear Project Memory | Permanently removes all ten locally stored projects without changing device or MIDI settings. | — |
