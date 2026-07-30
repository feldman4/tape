import type React from 'react';
import { useEffect, useRef } from 'react';
import type { Tape } from '../../tape/model';
import type { TransportState, UndoEntry } from '../tapeRefs';
import { btnStyle } from '../btnStyle';
import { CANVAS_WIDTH, CANVAS_HEIGHT } from '../canvasConstants';

const MINIMAP_WIDTH = CANVAS_WIDTH;
const MINIMAP_HEIGHT = 45;  // Increased to accommodate top spacing

function Minimap({ tape, sr, samplesPerPixel }: { tape: Tape; sr: number; samplesPerPixel: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Reset context state and scale for 2x resolution
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(2, 2);

    // Calculate total song length (end of last clip)
    let maxEndSamples = tape.tapeLength;
    for (const lane of tape.lanes) {
      for (const clip of lane.clips) {
        maxEndSamples = Math.max(maxEndSamples, clip.tapeStart + clip.duration);
      }
    }

    // Background
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, MINIMAP_WIDTH, MINIMAP_HEIGHT);

    // Draw all clips
    for (let li = 0; li < 4; li++) {
      const laneH = 8;  // Fixed height per lane
      const laneGap = 1;  // Gap between lanes
      const laneY = 5 + li * (laneH + laneGap);  // Start at y=5 to leave room for loop bar and viewport

      for (const clip of tape.lanes[li].clips) {
        const clipStartPx = (clip.tapeStart / maxEndSamples) * MINIMAP_WIDTH;
        const clipEndPx = ((clip.tapeStart + clip.duration) / maxEndSamples) * MINIMAP_WIDTH;
        const clipW = clipEndPx - clipStartPx;

        const isMuted = clip.muted || tape.lanes[li].muted;
        const isSelected = li === tape.activeLane && clip.tapeStart <= tape.playhead && tape.playhead < clip.tapeStart + clip.duration;
        let fillColor: string;
        if (isSelected) {
          fillColor = isMuted ? '#4a3a2a' : '#7c3000';
        } else if (isMuted) {
          fillColor = '#2a2a2a';
        } else if (li === tape.activeLane) {
          fillColor = '#0f3d6e';
        } else {
          fillColor = '#162435';
        }
        ctx.fillStyle = fillColor;
        ctx.fillRect(clipStartPx, laneY, clipW, laneH);
      }
    }

    // Draw vertical separator lines between lanes
    for (let li = 1; li < 4; li++) {
      const laneH = 8;
      const laneGap = 1;
      const separatorY = 5 + li * (laneH + laneGap) - laneGap / 2;
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, separatorY);
      ctx.lineTo(MINIMAP_WIDTH, separatorY);
      ctx.stroke();
    }

    // Draw current display window (no fill, just thick border)
    const windowSamples = CANVAS_WIDTH * samplesPerPixel;
    const windowStart = Math.max(0, tape.playhead - windowSamples / 2);
    const windowEnd = Math.min(maxEndSamples, windowStart + windowSamples);
    const windowStartPx = (windowStart / maxEndSamples) * MINIMAP_WIDTH;
    const windowEndPx = (windowEnd / maxEndSamples) * MINIMAP_WIDTH;
    const windowW = windowEndPx - windowStartPx;

    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.strokeRect(windowStartPx, 0, windowW, MINIMAP_HEIGHT);

    // Draw loop region bar at top (on top of everything)
    if (tape.loopEnabled && tape.loopOut > tape.loopIn) {
      const loopStartPx = (tape.loopIn / maxEndSamples) * MINIMAP_WIDTH;
      const loopEndPx = (tape.loopOut / maxEndSamples) * MINIMAP_WIDTH;
      const loopW = loopEndPx - loopStartPx;
      ctx.fillStyle = '#facc15';
      ctx.fillRect(loopStartPx, 2, loopW, 1);  // At y=2
    }

    // Draw playhead position (gray full height, red in current lane)
    const playheadPx = (tape.playhead / maxEndSamples) * MINIMAP_WIDTH;
    ctx.globalAlpha = 1;
    
    // Gray line across full height
    ctx.strokeStyle = '#a0a0a0';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(playheadPx, 0);
    ctx.lineTo(playheadPx, MINIMAP_HEIGHT);
    ctx.stroke();
    
    // Red line in current lane (drawn on top, fully opaque)
    const laneH = 8;  // Must match clip drawing
    const laneGap = 1;  // Must match clip drawing
    const laneY = 5 + tape.activeLane * (laneH + laneGap);
    ctx.strokeStyle = '#ff5555';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(playheadPx, laneY);
    ctx.lineTo(playheadPx, laneY + laneH);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }, [tape, sr, samplesPerPixel]);

  return <canvas ref={canvasRef} width={MINIMAP_WIDTH * 2} height={MINIMAP_HEIGHT * 2} style={{ display: 'block', width: MINIMAP_WIDTH, height: MINIMAP_HEIGHT }} />;
}

interface TapeTabProps {
  ready: boolean;
  handleInit: () => void;
  tape: Tape;
  transport: TransportState;
  sr: number;
  hasClips: boolean;
  syncRunning: boolean;
  syncBeatPosition: number;
  selectedClipId: string | null;
  undoStack: UndoEntry[];
  redoStack: UndoEntry[];
  lastClipBeats: number | null;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  viewWidthSamplesRef: React.RefObject<number>;
  handleRecord: () => void;
  handleStop: () => void;
  handlePlay: (withCountIn?: boolean) => void;
  handleCanvasMouseDown: (e: React.MouseEvent<HTMLCanvasElement>) => void;
  handleCanvasMouseMove: (e: React.MouseEvent<HTMLCanvasElement>) => void;
  handleCanvasMouseUp: () => void;
  handleSplit: () => void;
  handleJoin: () => void;
  handleLift: () => void;
  handleDrop: () => void;
  handleUndo: () => void;
  handleRedo: () => void;
  handleSetLoopIn: () => void;
  handleSetLoopOut: () => void;
  handleToggleLoop: () => void;
  handleLoopFromClip: () => void;
  clickEnabled: boolean;
  handleToggleClick: () => void;
}

export function TapeTab({
  ready, handleInit,
  tape, transport, sr, hasClips,
  syncRunning, syncBeatPosition,
  selectedClipId, undoStack, redoStack, lastClipBeats,
  canvasRef, viewWidthSamplesRef,
  handleRecord, handleStop, handlePlay,
  handleCanvasMouseDown, handleCanvasMouseMove, handleCanvasMouseUp,
  handleUndo, handleRedo,
  clickEnabled, handleToggleClick,
}: TapeTabProps) {
  return (
    <div style={{ maxWidth: CANVAS_WIDTH, margin: '0 auto' }}>
      {!ready && (
        <button onClick={handleInit} style={btnStyle}>Enable Audio + MIDI</button>
      )}
      {ready && (
        <>


          {/* Timeline canvas */}
          <canvas
            ref={canvasRef}
            width={CANVAS_WIDTH * 2}
            height={CANVAS_HEIGHT * 2}
            style={{ display: 'block', cursor: 'crosshair', marginBottom: 8, width: CANVAS_WIDTH, height: CANVAS_HEIGHT }}
            onMouseDown={handleCanvasMouseDown}
            onMouseMove={handleCanvasMouseMove}
            onMouseUp={handleCanvasMouseUp}
            onMouseLeave={handleCanvasMouseUp}
          />

          {/* Transport and Undo/Redo */}
          <div style={{ marginBottom: 8, display: 'flex', gap: 6, alignItems: 'center' }}>
            <button
              style={{ ...btnStyle,
                ...(transport === 'recording' ? { background: '#b91c1c', color: '#fff' }
                  : (transport === 'armed' || transport === 'counting-in') ? { background: '#7f1d1d', color: '#fca5a5' } : {}) }}
              onClick={() => void handleRecord()}
              disabled={!ready}>
              {transport === 'recording' ? '⏺ Rec ●'
                : transport === 'counting-in' ? '⏺ Count-in…'
                : transport === 'armed' ? '⏺ Arm'
                : '⏺ Record'}
            </button>
            <button style={{ ...btnStyle, ...(transport !== 'idle' ? { background: '#374151', color: '#f9fafb' } : {}) }} onClick={() => void handleStop()} disabled={!ready}>
              {transport === 'playing' ? '⏸ Pause' : '⏹ Stop'}
            </button>
            <button
              style={{ ...btnStyle, ...(transport === 'playing' ? { background: '#15803d', color: '#fff' } : {}) }}
              onClick={(e) => void handlePlay(e.shiftKey)}
              disabled={!ready || !hasClips || (transport !== 'idle' && transport !== 'playing' && transport !== 'armed')}>
              {transport === 'playing' ? '⏸ Pause' : '▶ Play'}
            </button>
            <button
              title="Metronome click (hotkey: m)"
              style={{ ...btnStyle, ...(clickEnabled ? { background: '#b45309', color: '#fde68a' } : {}) }}
              onClick={handleToggleClick}>
              {clickEnabled ? '♪ Click ●' : '♪ Click'}
            </button>
            <div style={{ flex: 1 }} />
            <button style={btnStyle} onClick={handleUndo} disabled={undoStack.length === 0}>↩ Undo ({undoStack.length})</button>
            <button style={btnStyle} onClick={handleRedo} disabled={redoStack.length === 0}>↪ Redo ({redoStack.length})</button>
          </div>

          {/* Minimap */}
          <div style={{ marginTop: 16 }}>
            <Minimap tape={tape} sr={sr} samplesPerPixel={viewWidthSamplesRef.current / CANVAS_WIDTH} />
          </div>

          {/* Clip info */}
          {hasClips && (
            <div style={{ marginTop: 8, fontSize: 12, color: '#71717a' }}>
              {tape.lanes[tape.activeLane].clips.length} clip{tape.lanes[tape.activeLane].clips.length !== 1 ? 's' : ''} on lane {tape.activeLane + 1}
              {' · '}tape {(tape.tapeLength / sr).toFixed(2)}s
              {selectedClipId && (() => {
                const c = tape.lanes[tape.activeLane].clips.find((x) => x.id === selectedClipId);
                return c ? ` · ${(c.tapeStart / sr).toFixed(2)}s–${((c.tapeStart + c.duration) / sr).toFixed(2)}s` : null;
              })()}
              {lastClipBeats !== null && ` · ${lastClipBeats.toFixed(3)} beats`}
              {' · '}{transport} | {(tape.playhead / sr).toFixed(2)}s · {tape.bpm} BPM · MIDI: {syncRunning ? `▶ ${syncBeatPosition.toFixed(1)}` : 'stopped'}
            </div>
          )}
        </>
      )}
    </div>
  );
}
