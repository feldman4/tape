// Canvas-drawn circular waveform ring for one slot: faint base ticks always
// visible, colored data ticks once a sample exists (blue = ready/playing,
// red = recording), and a bright progress arc while playing or recording.
// Purely a display — no pointer handlers, per docs/manual.md "Display".

import { useEffect, useRef } from 'react';
import type { Slot } from '../sampler/model';

interface SlotRingProps {
  slot: Slot;
  progress: number | null;
  tick: number;
  size?: number;
}

const BAR_COUNT = 48;

function draw(canvas: HTMLCanvasElement, slot: Slot, progress: number | null, size: number): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);

  const cx = size / 2;
  const cy = size / 2;
  const outerR = size / 2 - 6;
  const innerR = outerR * 0.5;
  const tickLen = 4;

  ctx.lineWidth = 1.5;
  ctx.strokeStyle = slot.state === 'empty' ? '#27272a' : '#3f3f46';
  for (let i = 0; i < BAR_COUNT; i++) {
    const angle = (i / BAR_COUNT) * Math.PI * 2 - Math.PI / 2;
    const x0 = cx + Math.cos(angle) * innerR;
    const y0 = cy + Math.sin(angle) * innerR;
    const x1 = cx + Math.cos(angle) * (innerR + tickLen);
    const y1 = cy + Math.sin(angle) * (innerR + tickLen);
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  }

  const isRecording = slot.state === 'recording';
  const peaks = isRecording ? slot.recordingPeaks : slot.peaks;
  if (peaks.length > 0) {
    const color = isRecording ? '#ef4444' : '#3b82f6';
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    for (let i = 0; i < BAR_COUNT; i++) {
      const t = i / BAR_COUNT;
      const peakIdx = Math.min(peaks.length - 1, Math.floor(t * peaks.length));
      const amp = peaks[peakIdx] ?? 0;
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
    ctx.lineWidth = 3;
    if (progress !== null) {
      ctx.arc(cx, cy, outerR + 3, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
      ctx.stroke();
    } else if (isRecording) {
      const spin = ((performance.now() / 700) % 1) * Math.PI * 2;
      ctx.arc(cx, cy, outerR + 3, spin, spin + Math.PI / 3);
      ctx.stroke();
    }
  }
}

export function SlotRing({ slot, progress, tick, size = 100 }: SlotRingProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (canvasRef.current) draw(canvasRef.current, slot, progress, size);
    // `tick` drives redraws for in-place mutations (peaks growing, progress advancing).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, size]);

  return <canvas ref={canvasRef} style={{ width: size, height: size }} />;
}
