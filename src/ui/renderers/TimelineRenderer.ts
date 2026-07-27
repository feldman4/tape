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

export const TOP_BAND_HEIGHT = 14;   // px — beat-tick + loop-marker strip at top
export const TIME_AXIS_HEIGHT = TOP_BAND_HEIGHT;  // alias for TapePage compat
export const LANE_LABEL_WIDTH = 0;   // no gutter

// Aliases kept so callers that import these still compile.
export const CLIP_TOP_MARGIN = TOP_BAND_HEIGHT;
export const CLIP_HEIGHT = 20; // nominal; actual = clipBlockHeight(canvasHeight)

export function laneRowHeight(canvasHeight: number): number {
  return Math.floor((canvasHeight - TOP_BAND_HEIGHT) / LANE_COUNT);
}
export function laneRowTop(laneIndex: number, canvasHeight: number): number {
  return TOP_BAND_HEIGHT + laneIndex * laneRowHeight(canvasHeight);
}
/** Clip is drawn at half the lane row height, vertically centred. */
function clipBlockHeight(lrh: number): number {
  return Math.max(4, Math.floor(lrh / 2));
}

/**
 * Main draw call — renders the full four-lane tape timeline.
 * @param snapMode When true, beat ticks are drawn in the top band.
 */
export function drawTimeline(
  ctx: CanvasRenderingContext2D,
  tape: Tape,
  pool: AudioPool,
  layout: TimelineLayout,
  selectedClipId: string | null,
  snapMode = true,
): void {
  const { canvasWidth, canvasHeight } = layout;
  const lrh = laneRowHeight(canvasHeight);
  const ch  = clipBlockHeight(lrh);

  // Background — pure black
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  // Loop region tint (below top band)
  if (tape.loopEnabled && tape.loopOut > tape.loopIn) {
    const lx = tapeToPixel(tape.loopIn,  layout);
    const lw = tapeToPixel(tape.loopOut, layout) - lx;
    ctx.fillStyle = 'rgba(250,204,21,0.06)';
    ctx.fillRect(lx, TOP_BAND_HEIGHT, lw, canvasHeight - TOP_BAND_HEIGHT);
  }

  // Lane tracks — no separators, no highlight boxes
  for (let li = 0; li < LANE_COUNT; li++) {
    const ly   = laneRowTop(li, canvasHeight);
    const clipY = ly + Math.floor((lrh - ch) / 2); // vertically centred in row

    // Clips
    for (const clip of tape.lanes[li]!.clips) {
      const clipX = tapeToPixel(clip.tapeStart, layout);
      const clipW = tapeToPixel(clip.tapeStart + clip.duration, layout) - clipX;
      if (clipX + clipW < 0 || clipX > canvasWidth) continue;

      const isSelected = clip.id === selectedClipId;
      const isMuted    = clip.muted || tape.lanes[li]!.muted;
      const isActive   = li === tape.activeLane;

      // Color logic:
      //   Muted (clip or lane)   → gray, no blue
      //   Selected (active lane, under playhead) → dark orange
      //   Active lane, other     → blue
      //   Non-active lane        → desaturated blue
      let fillColor: string;
      if (isMuted) {
        fillColor = '#2a2a2a';
      } else if (isSelected) {
        fillColor = '#7c3000';   // dark orange
      } else if (isActive) {
        fillColor = '#0f3d6e';   // blue
      } else {
        fillColor = '#162435';   // grayed-out blue
      }

      ctx.fillStyle = fillColor;
      ctx.fillRect(clipX, clipY, clipW, ch);

      if (clipW >= 4) {
        drawClipWaveform(ctx, clip, pool, clipX, clipY, clipW, ch, isMuted, isActive, isSelected);
      }

      if (isMuted && clipW > 30) {
        ctx.fillStyle = '#555';
        ctx.font = '9px sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText('M', clipX + 4, clipY + 11);
      }
    }
  }

  // Top band — beat ticks (sync mode only) + loop markers
  drawTopBand(ctx, tape, layout, canvasWidth, snapMode);

  // Playhead (always at canvas centre, full height)
  const phX = Math.round(canvasWidth / 2) + 0.5;
  ctx.strokeStyle = '#f87171';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(phX, 0);
  ctx.lineTo(phX, canvasHeight);
  ctx.stroke();
  ctx.lineWidth = 1;
}

/**
 * Draws the top band: beat ticks (snap mode only) and loop in/out markers.
 * The band spans y=0..TOP_BAND_HEIGHT and overlays the rest of the canvas.
 */
function drawTopBand(
  ctx: CanvasRenderingContext2D,
  tape: Tape,
  layout: TimelineLayout,
  canvasWidth: number,
  snapMode: boolean,
): void {
  const H = TOP_BAND_HEIGHT;
  const { playhead, samplesPerPixel } = layout;

  // Beat ticks — snap mode only
  if (snapMode) {
    const SAMPLE_RATE = 44100;
    const samplesPerBeat = (SAMPLE_RATE * 60) / tape.bpm;
    const beatWidthPx    = samplesPerBeat / samplesPerPixel;
    if (beatWidthPx >= 4) {
      const halfView  = (canvasWidth * samplesPerPixel) / 2;
      const viewStart = playhead - halfView;
      const viewEnd   = playhead + halfView;
      const firstBeat = Math.max(0, Math.ceil(viewStart / samplesPerBeat));
      const lastBeat  = Math.floor(viewEnd   / samplesPerBeat);
      ctx.lineWidth = 1;
      for (let i = firstBeat; i <= lastBeat; i++) {
        const x     = tapeToPixel(i * samplesPerBeat, layout);
        const isBar = i % 4 === 0;
        const tickH = isBar ? H : Math.round(H * 0.45);
        ctx.strokeStyle = isBar
          ? 'rgba(255,255,255,0.45)'
          : 'rgba(255,255,255,0.18)';
        ctx.beginPath();
        ctx.moveTo(x + 0.5, H - tickH);
        ctx.lineTo(x + 0.5, H);
        ctx.stroke();
      }
      ctx.lineWidth = 1;
    }
  }

  // Loop in / out markers — yellow when enabled, faint gray when disabled
  if (tape.loopOut > tape.loopIn) {
    const inX  = tapeToPixel(tape.loopIn,  layout);
    const outX = tapeToPixel(tape.loopOut, layout);
    ctx.fillStyle = tape.loopEnabled ? '#facc15' : '#4a4a4a';
    // In: vertical bar + small foot pointing right
    ctx.fillRect(inX,      0, 2, H);
    ctx.fillRect(inX,      H - 2, 5, 2);
    // Out: vertical bar + small foot pointing left
    ctx.fillRect(outX - 2, 0, 2, H);
    ctx.fillRect(outX - 5, H - 2, 5, 2);
  }
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
  selected: boolean,
): void {
  const samples = pool.get(clip.audioBufferId);
  if (!samples || clip.duration === 0) return;

  const mid = clipY + clipH / 2;
  const amp = (clipH / 2) * 0.85;
  const pixelCount = Math.ceil(clipW);
  const samplesPerPx = clip.duration / pixelCount;

  // Waveform is lighter than the clip background
  ctx.strokeStyle = muted
    ? '#444'
    : selected
    ? '#d46000'   // warm amber for selected (orange take)
    : active
    ? '#2878c8'   // lighter blue for active lane
    : '#2a4060';  // muted blue for other lanes

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

