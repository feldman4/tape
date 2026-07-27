```python
"""
Transport model for browser-based tape recorder synchronized to external MIDI clock.

Core idea
---------
Everything derives from one function:

    tape_time(browser_time) -> tape seconds

This maps browser (wall-clock) time onto the tape timeline.

Playback, recording, and MIDI synchronization all use this same function with
different latency offsets.

Definitions
-----------

browser_time
    Monotonic browser clock (performance.now() or AudioContext.currentTime).

tape_time
    Position on the virtual tape in seconds.

audio_out_latency (L_out)
    Time between rendering audio and hearing it.

audio_in_latency (L_in)
    Time between sound entering the interface and samples arriving in JS.

midi_latency (L_midi)
    Delay between OP-Z emitting a MIDI message and browser receiving it.

The transport estimate is continuously refined from incoming MIDI clock.
Small timing errors are corrected smoothly (PLL); only explicit transport
commands (Start, Song Position Pointer, user seek, rewind) perform hard jumps.
"""

from dataclasses import dataclass


# -----------------------------------------------------------------------------
# Transport state
# -----------------------------------------------------------------------------

@dataclass
class TransportEstimate:
    """
    Current estimate of tape position as a function of browser time.

    At browser_time:
        tape position = tape_time

    Afterwards:
        tape_time(t) =
            tape_time +
            (t - browser_time) * speed
    """

    browser_time: float
    tape_time: float
    speed: float = 1.0


# -----------------------------------------------------------------------------
# Core mapping
# -----------------------------------------------------------------------------

def tape_time_at(
    browser_time: float,
    transport: TransportEstimate,
) -> float:
    """
    Convert browser time -> tape time.
    """
    dt = browser_time - transport.browser_time
    return transport.tape_time + dt * transport.speed


# -----------------------------------------------------------------------------
# Playback
# -----------------------------------------------------------------------------

def playback_tape_time(
    browser_time: float,
    transport: TransportEstimate,
    audio_out_latency: float,
) -> float:
    """
    Tape position that should be rendered NOW.

    Audio rendered now will emerge from the speakers after
    audio_out_latency seconds, so render the future tape position.
    """
    return tape_time_at(
        browser_time + audio_out_latency,
        transport,
    )


# -----------------------------------------------------------------------------
# Recording
# -----------------------------------------------------------------------------

def recording_tape_time(
    browser_time: float,
    transport: TransportEstimate,
    audio_in_latency: float,
) -> float:
    """
    Tape position where newly received audio should be written.

    The captured audio actually occurred audio_in_latency seconds earlier.
    """
    return tape_time_at(
        browser_time - audio_in_latency,
        transport,
    )


# -----------------------------------------------------------------------------
# MIDI observation
# -----------------------------------------------------------------------------

def transport_from_midi(
    browser_time: float,
    observed_tape_time: float,
    midi_latency: float,
) -> TransportEstimate:
    """
    Construct a transport estimate from an incoming MIDI clock event.

    If the browser receives the MIDI message at browser_time,
    the musical event actually occurred midi_latency seconds earlier.
    """
    return TransportEstimate(
        browser_time=browser_time - midi_latency,
        tape_time=observed_tape_time,
    )


# -----------------------------------------------------------------------------
# Phase measurement
# -----------------------------------------------------------------------------

def phase_error(
    browser_time: float,
    observed_tape_time: float,
    transport: TransportEstimate,
) -> float:
    """
    Positive:
        estimate is behind

    Negative:
        estimate is ahead
    """
    predicted = tape_time_at(browser_time, transport)
    return observed_tape_time - predicted


# -----------------------------------------------------------------------------
# Simple PLL corrections
# -----------------------------------------------------------------------------

def correct_phase(
    transport: TransportEstimate,
    error: float,
    gain: float = 0.1,
) -> TransportEstimate:
    """
    Shift transport phase toward observation.

    Suitable for removing small accumulated offsets.
    """
    return TransportEstimate(
        browser_time=transport.browser_time,
        tape_time=transport.tape_time + gain * error,
        speed=transport.speed,
    )


def correct_speed(
    transport: TransportEstimate,
    error: float,
    gain: float = 0.02,
) -> TransportEstimate:
    """
    Slightly modify playback speed to eliminate long-term drift.

    In practice this behaves like a software capstan servo.
    """
    return TransportEstimate(
        browser_time=transport.browser_time,
        tape_time=transport.tape_time,
        speed=transport.speed + gain * error,
    )


# -----------------------------------------------------------------------------
# Usage
# -----------------------------------------------------------------------------

"""
Every subsystem uses the same transport function.

Playback:

    tape = playback_tape_time(
        browser_time,
        transport,
        L_out,
    )

Recording:

    tape = recording_tape_time(
        browser_time,
        transport,
        L_in,
    )

Incoming MIDI clock:

    1. Convert MIDI observation into tape_time.
    2. Compute phase_error().
    3. Gradually adjust phase and/or speed.
    4. Publish updated TransportEstimate.

Only explicit transport operations should perform instantaneous jumps:
    - MIDI Start
    - Song Position Pointer
    - User scrub
    - Rewind/Fast-forward

Ordinary MIDI clock jitter should be absorbed by the PLL rather than causing
playhead seeks.
"""
```