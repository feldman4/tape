// Synthetic click burst used by the loopback latency self-test. Shared
// between the AudioWorkletProcessor (which plays it) and the main-thread
// latency test (which searches for it via cross-correlation).
//
// This is a Hann-windowed tone burst rather than a single-sample-scale
// transient: a ~1-sample click has almost no energy once it has gone
// through a real acoustic path (speaker frequency response, room
// reflections, mic pickup), which made the correlation score unreliable
// (low confidence even when the round-trip was measured correctly). A
// short burst at a mid frequency both speakers and mics reproduce well
// gives the matched filter far more energy to lock onto.

const TONE_HZ = 2500;

// ~9ms at 44.1kHz. Long enough to carry real energy through an acoustic
// loopback, short enough to keep latency-measurement precision (~0.2ms).
export const CLICK_LENGTH = 400;

export function createClickWaveform(sampleRate = 44100): Float32Array {
  const waveform = new Float32Array(CLICK_LENGTH);
  for (let i = 0; i < CLICK_LENGTH; i++) {
    const t = i / CLICK_LENGTH;
    const envelope = Math.sin(t * Math.PI); // Hann-like: fades in and out, no edge clicks
    waveform[i] = envelope * Math.sin((2 * Math.PI * TONE_HZ * i) / sampleRate);
  }
  return waveform;
}
