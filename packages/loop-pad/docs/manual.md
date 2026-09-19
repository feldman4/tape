# 16-Slot MIDI Sampler

## Purpose

The sampler records and plays 16 audio clips from MIDI notes. It is designed for an OP-Z-led setup and runs in a Chromium browser on macOS. Ten projects preserve samples and mixer state in browser storage.

## Setup

1. Connect the OP-Z and audio interface.
2. Open the sampler in Chrome or Edge.
3. Allow microphone and MIDI access when prompted.
4. Open the configuration panel and select:
   - **Audio Input** — the signal to sample, such as a Scarlett input or BlackHole.
   - **Input Channels** — the stereo pair within the selected input used to record each sample.
   - **Audio Output** — the listening destination, such as the Scarlett or BlackHole.
   - **Output Channels** — a stereo pair on multi-output devices.
   - **MIDI Input** — the OP-Z or other controller sending notes and clock.
   - **MIDI Output** — the OP-Z, required only for count-in transport control.
5. Set the **MIDI Channel**, **First Sample Note**, **Delete Note**, and **Count-in Toggle Note**. The notes must not overlap.
6. Assign the four mixer CCs: **HPF Cutoff**, **LPF Cutoff**, **Pan**, and **Level** (CC 1–4 by default).
7. Select **Project 1–10** from the project dropdown.

The app remembers the last selected Audio Input, Input Channels, Audio Output, Audio Output Channels, MIDI Input, and MIDI Output in browser storage. On later visits, it automatically reconnects each device selector when a device with the same name becomes available, then restores remembered stereo input and output pairs when the device exposes them. If a remembered device or channel selection is unavailable, the selector uses its default until it appears or another selection is made.

## Sample notes

The **First Sample Note** begins one contiguous range of 16 notes. For example, if it is C2, the slots use C2 through D#3. Each note always controls the same slot. Only notes on the configured MIDI channel are accepted.

| Slot state | Sequencer state | Note On | Note Off |
| --- | --- | --- | --- |
| Empty, idle | Running | Start recording | Do nothing |
| Empty, idle | Stopped | Do nothing | Do nothing |
| Empty, recording | Any | Do nothing | Stop recording and store the sample |
| Sample loaded, stopped | Any | Start playback from the beginning | Do nothing |
| Sample loaded, playing | Any | Restart playback from the beginning | Stop playback |

Recording begins immediately. After Note Off, recording continues for the configurable recording-tail period (300 ms by default). Playback includes that tail with a decay over the same period. A slot records the selected audio input. Triggering other slots does not stop recording or playback. Stopping the sequencer stops all playback immediately.

## Deleting a sample

There is one global **Delete Note**.

1. Trigger a slot's sample note.
2. Trigger the Delete Note within 500 ms.

That slot is cleared. The two notes may arrive in either order, provided they are no more than 500 ms apart. Deleting a recording cancels it; deleting a playing sample stops it. When the sequencer is stopped, a Delete Note outside the 500 ms window does nothing.

When the sequencer is running, a Delete Note by itself clears the selected slot after the 500 ms pairing window. Recording a slot selects it; mixer CC adjustments continue to apply to the selected slot. The selected slot has a thin yellow outline. Starting playback does not change the selection, so a standalone Delete Note can undo the last recording.

Choose a Delete Note outside the 16-note sample range.

## Mixing

Each slot has four controls:

- **Level** — from silence to full level.
- **Pan** — from fully left through center to fully right.
- **LPF Cutoff** — lowers the low-pass cutoff as the CC value decreases.
- **HPF Cutoff** — raises the high-pass cutoff as the CC value increases.

The four globally assigned CC numbers control the **selected slot**. Completing a recording selects that slot, and subsequent CC adjustments continue to apply to it. Playing a slot does not change the selection.

CCs are accepted only on the configured MIDI channel. Until a slot is selected, mixer CCs do nothing. The filters have no resonance control. Filter slope and other advanced filter behavior are global settings in the configuration panel.

## Projects

Use the project dropdown to select **Project 1–10**. Each project stores its 16 samples and all per-sample mixer settings. Changes are saved automatically in the browser. Switching projects saves the current project, then loads the selected project.

Project playback and recording stop when switching projects. Device selections, MIDI and CC assignments, count-in settings, and global filter configuration are app settings and do not change with the project.

Browser storage belongs to the current browser profile and site. Clearing site data removes all projects, so use **Download Projects** for backup or transfer.

If the app reports that a locally stored project is invalid, select **Clear Project Memory** from the error screen or configuration panel. This permanently removes all ten local projects but keeps device and MIDI settings.

### Download and restore

**Download Projects** produces one ZIP containing exactly ten extensionless files:

`project-01`, `project-02`, …, `project-10`

To restore projects, upload that ZIP. The app restores each valid top-level file whose name exactly matches `project-01` through `project-10`. Matching projects are overwritten; missing projects are left unchanged; other files are ignored.

To restore one project, upload a single project file. Its contents overwrite the currently selected project regardless of its filename. Restoration takes effect immediately and cannot be undone except by restoring another backup.

## Display

The app name appears in the browser tab, not on the front panel. The panel contains 16 circular waveforms in note order, left to right and top to bottom. Four tiny knobs beside each waveform display Level, Pan, LPF Cutoff, and HPF Cutoff. The circles and knobs are displays, not mouse controls.

A narrow stereo input level meter runs down the left edge of the screen, showing the live L/R input signal (independent of any slot's recording/playback state). Each column is green under normal levels, orange as it approaches saturation, and red at/near saturation.

Their appearance shows each slot's state:

- Empty: no waveform.
- Recording: live recording progress.
- Ready: the stored waveform.
- Playing: playback progress over the waveform.
- Delete: the circle returns to empty.

All recording, playback, deletion, and mixing is performed by MIDI.

## Count-in

**Count-in** affects OP-Z transport start only; it does not delay an individual sample recording. Once the BPM indicator has a value, the front-panel **Count-in** button manually runs the same Stop, count, and Start procedure. The app plays an audible click for each count-in beat through the selected audio output.

Send a Note On for the **Count-in Toggle Note** on the configured MIDI channel to switch Count-in on or off. Its state is displayed on the front panel and cannot be changed there or in the configuration panel. The default toggle note is 74.

When Count-in is off, OP-Z Start passes through normally. When it is on:

1. The app receives OP-Z Start.
2. It immediately sends Stop.
3. It counts the configured number of beats using the most recently measured MIDI Clock tempo. If MIDI Clock continues while stopped, its pulses complete the count instead.
4. It sends Start to the OP-Z.

Set **Count-in Beats** to the desired length. The app derives tempo from MIDI clock; the OP-Z remains clock master. Count-in requires both MIDI input and MIDI output to be connected to the OP-Z.

The BPM indicator shows the tempo estimated from recent MIDI Clock pulses. It reads **?** until enough clock has arrived to estimate reliably, and again after MIDI Clock stops arriving (transport stopped, cable disconnected, etc.) instead of showing a stale number.

## Configuration panel

Select the gear button on the front panel to open the configuration panel. It contains device selection, numeric MIDI assignments, a filter-slope selector, and **Clear Project Memory**. **Input Channels** selects the stereo pair recorded into each sample. On devices with more than two output channels, **Output Channels** selects the stereo pair used for sample playback. The last user-selected input and output pairs are remembered and restored whenever a selected or automatically reconnected device exposes them. **Clear Project Memory** permanently removes all local projects while retaining device and MIDI settings. Project selection, download, restore, MIDI Clock state, BPM, and Count-in state remain on the front panel.

| Option | Function | Default |
| --- | --- | --- |
| MIDI Channel | Sets the channel used by sample notes, the Delete Note, Count-in Toggle Note, and mixer CCs. | 16 |
| First Sample Note | Sets the first note in the 16-note slot range. | 53 (F3) |
| Delete Note | Sets the note used with a slot note to clear that slot. | 76 |
| Count-in Toggle Note | Sets the note that toggles Count-in on and off. | 74 |
| HPF Cutoff CC | Sets the global CC number used for the selected slot's high-pass cutoff. | 1 |
| LPF Cutoff CC | Sets the global CC number used for the selected slot's low-pass cutoff. | 2 |
| Pan CC | Sets the global CC number used for the selected slot's pan. | 3 |
| Level CC | Sets the global CC number used for the selected slot's level. | 4 |
| Count-in Beats | Sets the number of beats before transport restarts while Count-in is on. | 4 |
| Recording Tail | Continues recording after Note Off and sets the playback decay duration. | 300 ms |
| Filter Slope | Sets the global LPF and HPF slope in the configuration panel. | 24 dB/oct |
| Audio Input | Selects the signal recorded into slots; its device name is remembered and reconnected automatically. | — |
| Input Channels | Selects the stereo pair from the audio input recorded into each sample; the last selected pair is restored when available. | 1–2 |
| Audio Output | Selects where sample playback is sent; its device name is remembered and reconnected automatically. | System default |
| Output Channels | Selects the stereo output pair for sample playback when the device exposes multiple pairs; the last selected pair is restored when available. | 1–2 |
| MIDI Input | Selects the source of notes, clock, and transport; its device name is remembered and reconnected automatically. | — |
| MIDI Output | Selects the destination for Stop and Start during count-in; its device name is remembered and reconnected automatically. | — |
| Clear Project Memory | Permanently removes all ten locally stored projects without changing device or MIDI settings. | — |

## Front-panel settings

| Setting | Function | Default |
| --- | --- | --- |
| Project | Selects Project 1–10, saving the current project before loading another. | 1 |
| Download Projects | Downloads all ten projects in one ZIP. | — |
| Restore | Restores matching projects from a ZIP or replaces the current project from one project file. | — |

## Notes

- Sample-note actions distinguish MIDI Note On from Note Off as shown above.
- MIDI velocity does not change recording or playback level.
- Mixer CC values use the standard MIDI range, 0–127.
- Samples are one-shots and can overlap.
- Reloading or closing the page preserves the current project in browser storage.
- Automatic reconnection matches the exact device name. Selecting another device updates the remembered choice.
