// Canvas-drawn circular waveform ring for one slot: colored data ticks once
// a sample exists (blue = finalized,
// amber = unfinished take, red = recording), and a bright progress arc while
// playing or recording.
// Purely a display — no pointer handlers, per docs/manual.md "Display".

import { useEffect, useRef } from 'react';
import { getSlotDisplayState, type Slot } from '../sampler/model';

interface SlotRingProps {
  slot: Slot;
  progress: number | null;
  tick: number;
}

const SIZE = 76;
const BAR_COUNT = 48;
const DISPLAY_NORMALIZATION_FLOOR = 0.05;

function draw(canvas: HTMLCanvasElement, slot: Slot, progress: number | null): void {
  const size = SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);

  const cx = size / 2;
  const cy = size / 2;
  const outerR = size / 2 - 2;
  const innerR = size * 0.33;
  const state = getSlotDisplayState(slot);

  const isRecording = state === 'recording';
  const peaks = isRecording ? slot.recordingPeaks : slot.sample?.peaks ?? [];
  if (peaks.length > 0) {
    const peakScale = Math.max(DISPLAY_NORMALIZATION_FLOOR, ...peaks);
    const color = isRecording ? '#ef4444' : slot.sample?.takeStatus === 'unfinalized' ? '#f59e0b' : '#008cff';
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    for (let i = 0; i < BAR_COUNT; i++) {
      const t = i / BAR_COUNT;
      const peakIdx = Math.min(peaks.length - 1, Math.floor(t * peaks.length));
      const amp = Math.min(1, (peaks[peakIdx] ?? 0) / peakScale);
      const len = Math.max(2, amp * (outerR - innerR));
      const angle = t * Math.PI * 2 - Math.PI / 2;
      const x0 = cx + Math.cos(angle) * innerR;
      const y0 = cy + Math.sin(angle) * innerR;
      const x1 = cx + Math.cos(angle) * (innerR + len);
      const y1 = cy + Math.sin(angle) * (innerR + len);
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    if (progress !== null) {
      ctx.arc(cx, cy, outerR, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
      ctx.stroke();
    } else if (isRecording) {
      const spin = ((performance.now() / 700) % 1) * Math.PI * 2;
      ctx.arc(cx, cy, outerR, spin, spin + Math.PI / 3);
      ctx.stroke();
    }
  }
}

export function SlotRing({ slot, progress, tick }: SlotRingProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (canvasRef.current) draw(canvasRef.current, slot, progress);
    // `tick` drives redraws for in-place mutations (peaks growing, progress advancing).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);

  return <canvas ref={canvasRef} style={{ width: SIZE, height: SIZE }} />;
}
