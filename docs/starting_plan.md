# Browser Tape Recorder Design

# 1. Vision

## Goals

* Browser-based tape recorder inspired by the OP-1 Field.
* Optimized for hardware synthesizers and external sequencers.
* Fast, touch-first workflow with minimal visual distraction.
* Non-destructive editing.
* Deterministic playback.
* MIDI synchronization.
* Runs on desktop and iPad using standard browser APIs.

## Core Design Principles

* Instrument, not DAW.
* One screen, one task.
* Four tape lanes plus master.
* Tape is the primary abstraction.
* Non-destructive editing.
* Immutable audio buffers.
* Audio engine owns state; UI is a view.

# 2. User Experience

## Primary Workflow

1. Connect hardware synth via audio interface.
2. Connect MIDI clock/start/stop.
3. Record takes.
4. Rearrange takes on tape.
5. Mix.
6. Export.

No plugin windows, inspectors, or floating panels.

## Recording Modes

### Free

Tape timeline is authoritative. Audio is placed according to interface timestamps and latency. Best for live playing.

### Sync

External MIDI clock is authoritative during recording. The recorder reconstructs time from the clock and renders the final clip onto the tape grid. Best for hardware sequencers.

# 3. Core Concepts


| Concept       | Description                                 |
| ------------- | ------------------------------------------- |
| Project       | Entire recording session                    |
| Tape          | Four-lane timeline                          |
| Lane          | One tape track                              |
| Clip          | Non-destructive reference to recorded audio |
| Audio Pool    | Immutable audio buffers                     |
| Recorded Take | Temporary recording before finalization     |
| Loop          | Playback region                             |
| Transport     | Play, stop, record, scrub                   |
| Tempo         | Beat/sample mapping                         |
| Action        | Semantic user command                       |

# 4. Architecture

```text
                    UI

                     │

              Controller Layer

                     │

       ┌─────────────┼─────────────┐

   Edit Engine   Transport   Sync Engine

       │             │             │

       └─────────────┼─────────────┘

               Audio Engine

                     │

              AudioWorklet DSP

                     │

              Audio Interface
```

## Engine Responsibilities


| Engine    | Responsibility                     |
| --------- | ---------------------------------- |
| Audio     | Playback, recording, mixing        |
| Edit      | Tape editing                       |
| Transport | Playhead and playback state        |
| Sync      | Tempo and external synchronization |
| UI        | Rendering                          |
| IO        | Input devices                      |

## Data Flow

Input Device → Action → Controller → Engine → Project State → Renderer

## Thread Model

### UI Thread

* React
* Canvas
* Input
* Project management

### AudioWorklet

* Playback
* Mixing
* Recording
* Tape DSP

No UI code runs inside the audio thread.

# 5. Data Model

## Project


| Field    | Description     |
| -------- | --------------- |
| Tape     | Four lanes      |
| Mixer    | Mixer state     |
| Tempo    | Tempo map       |
| Settings | Global settings |
| Undo     | Undo history    |

## Tape


| Field    | Description     |
| -------- | --------------- |
| Lanes    | Four lanes      |
| Playhead | Sample position |
| Loop     | Loop region     |
| Length   | Tape duration   |

## Lane


| Field | Description       |
| ----- | ----------------- |
| Clips | Ordered clip list |

## Clip


| Field         | Description               |
| ------------- | ------------------------- |
| AudioBufferID | Reference into Audio Pool |
| TapeStart     | Sample position           |
| SourceStart   | Offset into source buffer |
| Duration      | Samples                   |
| Gain          | Clip gain                 |
| Reverse       | Playback direction        |
| Muted         | Mute state                |

## Mixer


| Field         | Description    |
| ------------- | -------------- |
| Lane channels | Four           |
| Master        | Master channel |

## Audio Pool

Immutable storage: AudioBufferID → Float32Array

Recording creates new buffers.

Editing never modifies buffers.

## RecordedTake

Temporary object created while recording.


| Field             | Description           |
| ----------------- | --------------------- |
| Raw audio         | Captured samples      |
| Timestamp source  | Free or Sync          |
| Beat map          | Sample→beat mapping  |
| Interface latency | Measured latency      |
| Tape start        | Initial tape position |

Finalization converts a RecordedTake into one immutable Clip.

## Undo History

Command-based: Execute() ⇄ Undo()

# 6. Audio Engine

Responsibilities

* playback
* recording
* overdub
* transport
* mixer
* tape DSP
* master output

## Playback

Playhead → Find active clips → Mix → Tape DSP → Master → Output

## Recording

Input → Recorder → RecordedTake → Finalize → Audio Pool → Clip

## Mixer

Four tape lanes plus master.

Signal flow: Lane → Gain → Pan → EQ → Master → Limiter (future) → Output

## Tape DSP

Two modes:

**Digital**
Clean playback without tape character. Interpolation only.

**Analog**
Simulates vintage tape characteristics:

* wow/flutter
* saturation
* frequency response

# 7. Edit Engine


| Operation    | Description                        |
| ------------ | ---------------------------------- |
| Lift         | Remove clip and place on clipboard |
| Drop         | Insert clipboard clip              |
| Split        | Divide clip                        |
| Join         | Merge adjacent clips               |
| Move         | Shift clip                         |
| Set Loop In  | Set loop start point               |
| Set Loop Out | Set loop end point                 |
| Undo         | Reverse previous edit              |

All operations are non-destructive.

Only clip metadata changes.

# 8. Recording

## Free Mode

Timestamp source: Audio Interface

Placement: Tape Sample = Start Sample + Recorded Sample Index

No stretching.

## Sync Mode

Timestamp source: External MIDI Clock

Recorder stores

* audio
* beat timestamps

After recording: Raw Audio + Beat Map → Time Reconstruction → Resampled Clip → Audio Pool

The rendered clip exactly matches the external sequencer's beat duration.

Example: External clock 10.0 beats, Tape elapsed 10.1 beats → Stretch → 10.0 beat clip

## Timestamp Sources


| Source          | Status    |
| --------------- | --------- |
| Audio Interface | Supported |
| MIDI Clock      | Supported |
| Internal Tempo  | Planned   |
| Ableton Link    | Future    |
| SMPTE / MTC     | Future    |

# 9. Synchronization

Responsibilities

* tempo
* beat position
* external clock
* transport synchronization

Supported MIDI messages

* Clock
* Start
* Continue
* Stop

Provides Samples ↔ Beats conversion for the entire application.

# 10. Mixer

## Signal Flow

Lane 1, Lane 2, Lane 3, Lane 4 → Master → Output

## Lane Controls

* Gain
* Pan
* Mute
* Solo
* Three-band EQ
* Send A
* Send B

## Master Controls

* Gain
* Three-band EQ
* Limiter (future)

## EQ

Simple three-band design: Low Shelf → Mid Bell → High Shelf

# 11. User Interface


| Page     | Purpose                     |
| -------- | --------------------------- |
| Tape     | Recording, editing, looping |
| Mixer    | Mixing                      |
| Project  | Save/export                 |
| Settings | Hardware and preferences    |

Only one page is visible.

## Tape Page

Shows

* four lanes
* playhead
* loop region
* waveforms

Primary actions

* Lift
* Drop
* Split
* Join
* Move

## Mixer Page

Displays one channel at a time.

Swipe: Lane 1 ↔ Lane 2 ↔ Lane 3 ↔ Lane 4 ↔ Master

# 12. Input

## Supported Inputs


| Input    | Purpose              |
| -------- | -------------------- |
| Mouse    | Desktop interaction  |
| Touch    | Tablets              |
| Keyboard | Shortcuts            |
| MIDI     | Hardware controllers |

## Semantic Actions

Every device emits Actions.

Example: Touch → Action → Transport.Play or MIDI CC → Action → Transport.Record

The engines never receive raw input events.

## Gesture Recognition

Supported gestures

* Tap
* Double tap
* Drag
* Two-finger scrub

Gestures map to Actions.

# 13. User Interactions

## Transport

| Interaction           | Notes                                                                |
| --------------------- | -------------------------------------------------------------------- |
| Select active lane    | One active recording/edit lane.                                      |
| Play                  | Start playback from current playhead.                                |
| Stop                  | Stop playback or recording.                                          |
| Record                | Supports Free and Sync recording modes.                              |
| Rewind / Fast-forward | Continuous scrubbing                                                 |
| Scrub                 | Sample-accurate scrubbing with audio feedback.                       |
| Varispeed             | Continuous speed control plus common presets (½×, 1×, 2×, etc.). |
| Reverse playback      | Reverse transport direction.                                         |

## Editing

| Interaction       | Notes                                                          |
| ----------------- | -------------------------------------------------------------- |
| Move take (free)  | Continuous positioning in sample space.                        |
| Move take (beat snap) | Position quantized to beats or bars.                       |
| Lift              | Remove selected clip from tape and place on clipboard.         |
| Drop              | Insert clipboard at playhead. Repeated drops duplicate clip.   |
| Split             | Split selected clip at playhead.                               |
| Join              | Join adjacent clips.                                           |
| Undo              | Multi-level undo for edit operations.                          |

## Lanes & Loops

| Interaction      | Notes                                                   |
| ---------------- | ------------------------------------------------------- |
| Lift all lanes   | Copy corresponding material from all four lanes.        |
| Lift loop region | Lift material inside the current loop region.           |
| Set loop in      | Set loop start marker.                                  |
| Set loop out     | Set loop end marker.                                    |
| Toggle loop      | Enable or disable looping.                              |
| Loop current take | Set loop to the selected clip bounds.                   |

# 14. Rendering

Canvas-based.

React manages layout only.

Dedicated renderers

* Timeline
* Mixer
* Waveforms

## Timeline Renderer

Draws

* clips
* waveforms
* playhead
* loop region

The renderer never edits state.

## Performance

Waveforms should be cached.

Only visible regions are rendered.

Playback should never depend on rendering.

# 15. Tape Model

Tape is the primary object.

Tape → Playhead → Lanes → Clips → Audio Buffers

## Editing

Tape editing is non-destructive.

Lift

removes clip references.

Drop

creates new references.

Split and Join modify metadata only.

## Playback

Playback reads clip references.

Audio buffers remain immutable.

## Transport

Supports

* Play
* Stop
* Record
* Scrub

## Clip Movement

Two coordinate systems: Samples (continuous) and Bars / Beats / Ticks (quantized)

# 16. Timing Model

Two coordinate systems: Sample Space (continuous audio) and Beat Space (musical time).

## Mapping

Tempo provides Samples ↔ Beats conversion.

## Free Recording

Timeline authority: Audio Interface

Samples are written directly onto tape.

## Sync Recording

Timeline authority: External Clock

Recorder stores: Audio + Beat Map

Finalization reconstructs the clip in beat space before placing it onto tape.

## Latency

Input latency is measured independently of synchronization.

Latency compensation adjusts recording start.

Time reconstruction adjusts clip duration.

These are separate operations.

# Summary

The system is organized around a single abstraction: a four-lane tape whose timeline is the authoritative representation of the project. Audio is stored as immutable buffers referenced by non-destructive clips. Real-time responsibilities are isolated in the AudioWorklet, editing is performed through an Edit Engine operating on clip metadata, and all interaction—mouse, touch, keyboard, or MIDI—is translated into semantic Actions before reaching the engines. Two recording modes are supported: Free mode, where interface time defines the recording, and Sync mode, where an external MIDI clock defines musical time and the final clip is reconstructed to align exactly with the tape's tempo grid.
