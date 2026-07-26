// Timeline Renderer — four-lane tape timeline.
// Draws clips at their tape positions, loop region, playhead, time axis, and loop markers.
// Never mutates state.

import type { Tape } from '../../tape/model';
import { LANE_COUNT } from '../../tape/model';
import type { AudioPool } from '../../audio/audioPool';

export interface TimelineLayout {
  canvasWidth: number;
  canvasHeight: number;
  /** Tape sample at the horizontal center of the canvas (the playhead position). */
  playhead: number;
  /** Zoom: how many tape samples map to one pixel. */
  samplesPerPixel: number;
}

/** Converts a tape sample position to a canvas x pixel.
 *  The playhead is always at canvasWidth/2; tape scrolls past it. */
export function tapeToPixel(tapeSample: number, layout: TimelineLayout): number {
  const { playhead, samplesPerPixel, canvasWidth } = layout;
  return canvasWidth / 2 + (tapeSample - playhead) / samplesPerPixel;
}

/** Converts a canvas x pixel to a tape sample position. */
export function pixelToTape(px: number, layout: TimelineLayout): number {
  const { playhead, samplesPerPixel, canvasWidth } = layout;
  return playhead + (px - canvasWidth / 2) * samplesPerPixel;
}

export const TIME_AXIS_HEIGHT = 20;  // px — time ruler at top
export const LANE_LABEL_WIDTH = 20;  // px — lane number gutter on left

// Aliases kept so existing TapePage imports still compile.
export const CLIP_TOP_MARGIN = TIME_AXIS_HEIGHT;
export const CLIP_HEIGHT = 36; // nominal; actual = clipBlockHeight(canvasHeight)

const LOOP_MARKER_HEIGHT = 10;

export function laneRowHeight(canvasHeight: number): number {
  return Math.floor((canvasHeight - TIME_AXIS_HEIGHT) / LANE_COUNT);
}
export function laneRowTop(laneIndex: number, canvasHeight: number): number {
  return TIME_AXIS_HEIGHT + laneIndex * laneRowHeight(canvasHeight);
}
function clipBlockHeight(canvasHeight: number): number {
  return laneRowHeight(canvasHeight) - 4;
}

/**
 * Main draw call — renders the full four-lane tape timeline.
 */
export function drawTimeline(
  ctx: CanvasRenderingContext2D,
  tape: Tape,
  pool: AudioPool,
  layout: TimelineLayout,
  selectedClipId: string | null,
): void {
  const { canvasWidth, canvasHeight } = layout;
  const lh = laneRowHeight(canvasHeight);
  const ch = clipBlockHeight(canvasHeight);

  // Background
  ctx.fillStyle = '#09090b';
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  // Loop region tint
  if (tape.loopEnabled && tape.loopOut > tape.loopIn) {
    const lx = tapeToPixel(tape.loopIn, layout);
    const lw = tapeToPixel(tape.loopOut, layout) - lx;
    ctx.fillStyle = 'rgba(250,204,21,0.07)';
    ctx.fillRect(lx, TIME_AXIS_HEIGHT, lw, canvasHeight - TIME_AXIS_HEIGHT);
  }

  // Beat grid
  drawBeatGrid(ctx, layout, tape.bpm, canvasWidth, canvasHeight);

  // Lane tracks
  for (let li = 0; li < LANE_COUNT; li++) {
    const ly = laneRowTop(li, canvasHeight);
    const clipY = ly + 2;

    // Active-lane highlight
    if (li === tape.activeLane) {
      ctx.fillStyle = 'rgba(99,102,241,0.12)';
      ctx.fillRect(LANE_LABEL_WIDTH, ly, canvasWidth - LANE_LABEL_WIDTH, lh);
    }

    // Lane separator
    if (li > 0) {
      ctx.strokeStyle = '#27272a';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(LANE_LABEL_WIDTH, ly + 0.5);
      ctx.lineTo(canvasWidth, ly + 0.5);
      ctx.stroke();
    }

    // Clips
    for (const clip of tape.lanes[li]!.clips) {
      const clipX = tapeToPixel(clip.tapeStart, layout);
      const clipW = tapeToPixel(clip.tapeStart + clip.duration, layout) - clipX;
      if (clipX + clipW < LANE_LABEL_WIDTH || clipX > canvasWidth) continue;

      const isSelected = clip.id === selectedClipId;
      const isMuted = clip.muted;
      const isActive = li === tape.activeLane;

      ctx.fillStyle = isMuted ? '#3f3f46' : isSelected ? '#1d4ed8' : isActive ? '#1e3a5f' : '#1c3048';
      ctx.fillRect(clipX, clipY, clipW, ch);

      ctx.strokeStyle = isSelected ? '#60a5fa' : isActive ? '#2563eb' : '#1d4a6e';
      ctx.lineWidth = isSelected ? 2 : 1;
      ctx.strokeRect(clipX + 0.5, clipY + 0.5, Math.max(1, clipW - 1), ch - 1);
      ctx.lineWidth = 1;

      if (clipW >= 4) {
        drawClipWaveform(ctx, clip, pool, clipX, clipY, clipW, ch, isMuted, isActive);
      }

      if (isMuted && clipW > 30) {
        ctx.fillStyle = '#71717a';
        ctx.font = '9px sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText('M', clipX + 4, clipY + 11);
      }
    }
  }

  // Lane number labels (left gutter)
  ctx.font = 'bold 10px sans-serif';
  ctx.textAlign = 'center';
  for (let li = 0; li < LANE_COUNT; li++) {
    const ly = laneRowTop(li, canvasHeight);
    ctx.fillStyle = li === tape.activeLane ? '#818cf8' : '#52525b';
    ctx.fillText(String(li + 1), LANE_LABEL_WIDTH / 2, ly + lh / 2 + 4);
  }

  // Time axis
  drawTimeAxis(ctx, layout, canvasWidth);

  // Loop markers
  if (tape.loopOut > tape.loopIn) drawLoopMarkers(ctx, tape, layout, canvasHeight);

  // Playhead (always at center)
  const phX = canvasWidth / 2;
  ctx.strokeStyle = '#f87171';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(phX, 0);
  ctx.lineTo(phX, canvasHeight);
  ctx.stroke();
  ctx.lineWidth = 1;
  ctx.fillStyle = '#f87171';
  ctx.beginPath();
  ctx.moveTo(phX, TIME_AXIS_HEIGHT);
  ctx.lineTo(phX - 5, 2);
  ctx.lineTo(phX + 5, 2);
  ctx.closePath();
  ctx.fill();
}

function drawBeatGrid(
  ctx: CanvasRenderingContext2D,
  layout: TimelineLayout,
  bpm: number,
  canvasWidth: number,
  canvasHeight: number,
): void {
  const SAMPLE_RATE = 44100;
  const samplesPerBeat = (SAMPLE_RATE * 60) / bpm;
  const samplesPerBar  = samplesPerBeat * 4;

  const { playhead, samplesPerPixel } = layout;
  const halfView  = (canvasWidth * samplesPerPixel) / 2;
  const viewStart = playhead - halfView;
  const viewEnd   = playhead + halfView;

  const barWidthPx  = samplesPerBar  / samplesPerPixel;
  const beatWidthPx = samplesPerBeat / samplesPerPixel;

  if (barWidthPx < 4) return;
  const drawBeats = beatWidthPx >= 8;
  const step = drawBeats ? samplesPerBeat : samplesPerBar;
  const beatsPerStep = drawBeats ? 1 : 4;
  const firstIndex = Math.ceil(viewStart / step);
  const lastIndex  = Math.floor(viewEnd   / step);

  ctx.lineWidth = 1;
  for (let i = firstIndex; i <= lastIndex; i++) {
    const tapeSample = i * step;
    const x = tapeToPixel(tapeSample, layout);
    const isBar = (i * beatsPerStep) % 4 === 0;
    ctx.strokeStyle = isBar ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.04)';
    ctx.beginPath();
    ctx.moveTo(x + 0.5, TIME_AXIS_HEIGHT);
    ctx.lineTo(x + 0.5, canvasHeight);
    ctx.stroke();
  }
  ctx.lineWidth = 1;
}

function drawClipWaveform(
  ctx: CanvasRenderingContext2D,
  clip: { audioBufferId: string; sourceStart: number; duration: number },
  pool: AudioPool,
  clipX: number,
  clipY: number,
  clipW: number,
  clipH: number,
  muted: boolean,
  active: boolean,
): void {
  const samples = pool.get(clip.audioBufferId);
  if (!samples || clip.duration === 0) return;

  const mid = clipY + clipH / 2;
  const amp = (clipH / 2) * 0.85;
  const pixelCount = Math.ceil(clipW);
  const samplesPerPx = clip.duration / pixelCount;

  ctx.strokeStyle = muted ? '#3f3f46' : active ? '#4ade80' : '#2d9a5f';
  ctx.beginPath();
  for (let px = 0; px < pixelCount; px++) {
    const s0 = clip.sourceStart + Math.floor(px * samplesPerPx);
    const s1 = clip.sourceStart + Math.min(clip.duration, Math.floor((px + 1) * samplesPerPx));
    let min = 1, max = -1;
    for (let i = s0; i < s1; i++) {
      const s = samples[i] ?? 0;
      if (s < min) min = s;
      if (s > max) max = s;
    }
    const x = clipX + px + 0.5;
    ctx.moveTo(x, mid + min * amp);
    ctx.lineTo(x, mid + max * amp);
  }
  ctx.stroke();
}

function drawTimeAxis(
  ctx: CanvasRenderingContext2D,
  layout: TimelineLayout,
  canvasWidth: number,
): void {
  const { playhead, samplesPerPixel } = layout;
  const sampleRate = 44100;
  const visibleSamples = canvasWidth * samplesPerPixel;
  const viewStart = playhead - visibleSamples / 2;
  const viewEnd   = playhead + visibleSamples / 2;
  const tickIntervalSecs = pickTickInterval(visibleSamples / sampleRate);
  const tickIntervalSamples = tickIntervalSecs * sampleRate;

  ctx.fillStyle = '#18181b';
  ctx.fillRect(0, 0, canvasWidth, TIME_AXIS_HEIGHT);

  ctx.strokeStyle = '#3f3f46';
  ctx.fillStyle = '#71717a';
  ctx.font = '9px sans-serif';
  ctx.textAlign = 'center';

  const firstTick = Math.ceil(viewStart / tickIntervalSamples) * tickIntervalSamples;
  for (let tick = firstTick; tick <= viewEnd; tick += tickIntervalSamples) {
    const x = tapeToPixel(tick, layout);
    ctx.beginPath();
    ctx.moveTo(x, TIME_AXIS_HEIGHT - 4);
    ctx.lineTo(x, TIME_AXIS_HEIGHT);
    ctx.stroke();
    ctx.fillText(formatTime(tick / sampleRate), x, TIME_AXIS_HEIGHT - 5);
  }
}

function pickTickInterval(visibleSecs: number): number {
  for (const c of [0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 120]) {
    if (visibleSecs / c <= 8) return c;
  }
  return 120;
}

function formatTime(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = (secs % 60).toFixed(1);
  return m > 0 ? `${m}:${s.padStart(4, '0')}` : `${s}s`;
}

function drawLoopMarkers(
  ctx: CanvasRenderingContext2D,
  tape: Tape,
  layout: TimelineLayout,
  canvasHeight: number,
): void {
  const inX  = tapeToPixel(tape.loopIn,  layout);
  const outX = tapeToPixel(tape.loopOut, layout);
  ctx.fillStyle = '#facc15';
  ctx.fillRect(inX,      canvasHeight - LOOP_MARKER_HEIGHT, 2, LOOP_MARKER_HEIGHT);
  ctx.fillRect(inX,      canvasHeight - LOOP_MARKER_HEIGHT, 5, 2);
  ctx.fillRect(outX - 2, canvasHeight - LOOP_MARKER_HEIGHT, 2, LOOP_MARKER_HEIGHT);
  ctx.fillRect(outX - 5, canvasHeight - LOOP_MARKER_HEIGHT, 5, 2);
}

// ---------------------------------------------------------------------------
// Legacy helpers kept for the latency test path which still uses them directly
// ---------------------------------------------------------------------------
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

