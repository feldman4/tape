// Binary (de)serialization for a whole 16-slot Project into one flat,
// extensionless blob — used both as the IndexedDB-persisted project record
// payload and as the "project-01".."project-10" files inside the Download/
// Restore ZIP (see docs/manual.md "Download and restore").
//
// Format (little-endian):
//   magic: 4 bytes "LPP2"
//   for each of 16 slots, in order:
//     hasSample: uint8 (0 or 1)
//     sampleRate: float32
//     level, pan, lpfCutoff, hpfCutoff: float32 each
//     if hasSample: frameCount: uint32, then left and right float32 channels

import { SLOT_COUNT, computePeaks, makeDefaultSlot, type Project, type Slot, type StereoSamples } from './model';

const MAGIC = 'LPP2';

export function encodeProject(project: Project): Uint8Array {
  let totalLength = MAGIC.length;
  for (const slot of project.slots) {
    totalLength += 1 + 4 + 16; // hasSample flag + sampleRate + 4 mixer floats
    if (slot.samples && slot.samples.left.length > 0) totalLength += 4 + slot.samples.left.length * 8;
  }

  const out = new Uint8Array(totalLength);
  const view = new DataView(out.buffer);
  let offset = 0;
  out.set(new TextEncoder().encode(MAGIC), offset);
  offset += MAGIC.length;

  for (const slot of project.slots) {
    const hasSample = slot.samples !== null && slot.samples.left.length > 0;
    out[offset] = hasSample ? 1 : 0;
    offset += 1;
    view.setFloat32(offset, slot.sampleRate, true); offset += 4;
    view.setFloat32(offset, slot.mixer.level, true); offset += 4;
    view.setFloat32(offset, slot.mixer.pan, true); offset += 4;
    view.setFloat32(offset, slot.mixer.lpfCutoff, true); offset += 4;
    view.setFloat32(offset, slot.mixer.hpfCutoff, true); offset += 4;
    if (hasSample) {
      const samples = slot.samples!;
      view.setUint32(offset, samples.left.length, true); offset += 4;
      out.set(new Uint8Array(samples.left.buffer, samples.left.byteOffset, samples.left.byteLength), offset);
      offset += samples.left.byteLength;
      out.set(new Uint8Array(samples.right.buffer, samples.right.byteOffset, samples.right.byteLength), offset);
      offset += samples.right.byteLength;
    }
  }
  return out;
}

export function decodeProject(bytes: Uint8Array): Project {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = new TextDecoder().decode(bytes.subarray(0, 4));
  if (magic !== MAGIC) throw new Error('Not a valid Loop Pad project file');

  let offset = 4;
  const slots: Slot[] = [];
  for (let i = 0; i < SLOT_COUNT; i++) {
    const hasSample = bytes[offset] === 1;
    offset += 1;
    const sampleRate = view.getFloat32(offset, true); offset += 4;
    const level = view.getFloat32(offset, true); offset += 4;
    const pan = view.getFloat32(offset, true); offset += 4;
    const lpfCutoff = view.getFloat32(offset, true); offset += 4;
    const hpfCutoff = view.getFloat32(offset, true); offset += 4;

    let samples: StereoSamples | null = null;
    if (hasSample) {
      const count = view.getUint32(offset, true); offset += 4;
      const left = new Float32Array(bytes.buffer.slice(bytes.byteOffset + offset, bytes.byteOffset + offset + count * 4));
      offset += count * 4;
      const right = new Float32Array(bytes.buffer.slice(bytes.byteOffset + offset, bytes.byteOffset + offset + count * 4));
      offset += count * 4;
      samples = { left, right };
    }

    const slot = makeDefaultSlot();
    slot.samples = samples;
    slot.sampleRate = sampleRate;
    slot.mixer = { level, pan, lpfCutoff, hpfCutoff };
    slot.state = samples ? 'stopped' : 'empty';
    slot.peaks = samples ? computePeaks(samples) : [];
    slots.push(slot);
  }
  return { slots };
}

