// Minimal Timeline Renderer (Stage 0: single lane, no editing).
// Draws a cached min/max waveform plus a playhead line. Never mutates state.

export function drawWaveform(ctx: CanvasRenderingContext2D, samples: Float32Array, width: number, height: number): void {
  ctx.fillStyle = '#18181b';
  ctx.fillRect(0, 0, width, height);
  if (samples.length === 0) return;

  const mid = height / 2;
  const samplesPerPixel = Math.max(1, Math.floor(samples.length / width));

  ctx.strokeStyle = '#4ade80';
  ctx.beginPath();
  for (let x = 0; x < width; x++) {
    const start = x * samplesPerPixel;
    let min = 1;
    let max = -1;
    for (let i = 0; i < samplesPerPixel; i++) {
      const s = samples[start + i];
      if (s === undefined) break;
      if (s < min) min = s;
      if (s > max) max = s;
    }
    ctx.moveTo(x + 0.5, mid + min * mid);
    ctx.lineTo(x + 0.5, mid + max * mid);
  }
  ctx.stroke();
}

export function drawPlayhead(ctx: CanvasRenderingContext2D, x: number, height: number): void {
  ctx.strokeStyle = '#f87171';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, height);
  ctx.stroke();
  ctx.lineWidth = 1;
}
