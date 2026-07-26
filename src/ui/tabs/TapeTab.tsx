import type React from 'react';
import type { Clip, Tape } from '../../tape/model';
import type { TransportState, Mode, UndoEntry } from '../tapeRefs';
import { btnStyle } from '../btnStyle';
import { CANVAS_WIDTH, CANVAS_HEIGHT } from '../canvasConstants';

interface TapeTabProps {
  ready: boolean;
  handleInit: () => void;
  tape: Tape;
  transport: TransportState;
  mode: Mode;
  snap: boolean;
  sr: number;
  canEdit: boolean;
  canSwitchMode: boolean;
  hasClips: boolean;
  syncRunning: boolean;
  syncBeatPosition: number;
  selectedClipId: string | null;
  clipboard: Clip | null;
  undoStack: UndoEntry[];
  redoStack: UndoEntry[];
  lastClipBeats: number | null;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  setMode: (mode: Mode) => void;
  setSnap: (fn: (prev: boolean) => boolean) => void;
  handleLaneMute: (laneIndex: 0 | 1 | 2 | 3) => void;
  setActiveLane: (lane: 0 | 1 | 2 | 3) => void;
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
}

export function TapeTab({
  ready, handleInit,
  tape, transport, mode, snap, sr, canEdit, canSwitchMode, hasClips,
  syncRunning, syncBeatPosition,
  selectedClipId, clipboard, undoStack, redoStack, lastClipBeats,
  canvasRef,
  setMode, setSnap,
  handleLaneMute, setActiveLane,
  handleRecord, handleStop, handlePlay,
  handleCanvasMouseDown, handleCanvasMouseMove, handleCanvasMouseUp,
  handleSplit, handleJoin, handleLift, handleDrop,
  handleUndo, handleRedo,
  handleSetLoopIn, handleSetLoopOut, handleToggleLoop, handleLoopFromClip,
}: TapeTabProps) {
  return (
    <div style={{ maxWidth: CANVAS_WIDTH, margin: '0 auto' }}>
      {!ready && (
        <button onClick={handleInit} style={btnStyle}>Enable Audio + MIDI</button>
      )}
      {ready && (
        <>
          {/* Lane selector + status bar */}
          <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginBottom: 6 }}>
            {([0, 1, 2, 3] as const).map((i) => {
              const isMuted = tape.lanes[i].muted;
              const isActive = tape.activeLane === i;
              return (
                <button key={i}
                  onClick={(e) => {
                    if (e.shiftKey) {
                      handleLaneMute(i);
                    } else {
                      setActiveLane(i);
                    }
                  }}
                  title={isMuted
                    ? `Lane ${i + 1} — muted (Shift+click, Shift+${i + 1}, or OP-Z Shift+white key to unmute)`
                    : `Lane ${i + 1} — Shift+click, Shift+${i + 1}, or OP-Z Shift+white key to mute`}
                  style={{ ...btnStyle,
                    background: isActive ? '#4338ca' : '#27272a',
                    borderColor: isActive ? '#6366f1' : '#3f3f46',
                    minWidth: 28,
                    fontWeight: isActive ? 600 : 400,
                    opacity: isMuted ? 0.4 : 1,
                    textDecoration: isMuted ? 'line-through' : 'none',
                  }}>
                  {i + 1}
                </button>
              );
            })}
            <span style={{ fontSize: 13, color: '#a1a1aa', marginLeft: 10 }}>
              {transport} | {(tape.playhead / sr).toFixed(2)}s
            </span>
            <span style={{ fontSize: 14, color: '#e4e4e7', marginLeft: 10, fontVariantNumeric: 'tabular-nums' }}>
              {tape.bpm} BPM
            </span>
            <span style={{ fontSize: 12, color: '#a1a1aa', marginLeft: 10 }}>
              MIDI: {syncRunning ? `▶ ${syncBeatPosition.toFixed(1)}` : 'stopped'}
            </span>
          </div>

          {/* Mode + Snap */}
          <div style={{ marginBottom: 6, display: 'flex', gap: 16, alignItems: 'center' }}>
            <label><input type="radio" checked={mode === 'free'} onChange={() => setMode('free')} disabled={!canSwitchMode} />{' '}Free</label>
            <label><input type="radio" checked={mode === 'sync'} onChange={() => setMode('sync')} disabled={!canSwitchMode} />{' '}Sync</label>
            <label title="Snap scrub / slide / loop points to beat grid (X to toggle)">
              <input type="checkbox" checked={snap} onChange={() => setSnap((s) => !s)} />{' '}Snap
            </label>
          </div>

          {/* Transport */}
          <div style={{ marginBottom: 8, display: 'flex', gap: 6 }}>
            <button
              style={{ ...btnStyle,
                ...(transport === 'recording' ? { background: '#b91c1c', color: '#fff' }
                  : (transport === 'armed' || transport === 'counting-in') ? { background: '#7f1d1d', color: '#fca5a5' } : {}) }}
              onClick={() => void handleRecord()}
              disabled={!ready}>
              {transport === 'recording' ? '⏺ Rec ●'
                : transport === 'counting-in' ? '⏺ Count-in…'
                : (transport === 'armed' || mode === 'sync') ? '⏺ Arm'
                : '⏺ Record'}
            </button>
            <button style={{ ...btnStyle, ...(transport !== 'idle' ? { background: '#374151', color: '#f9fafb' } : {}) }} onClick={() => void handleStop()} disabled={!ready}>
              {transport === 'playing' ? '⏸ Pause' : '⏹ Stop'}
            </button>
            <button
              style={{ ...btnStyle, ...(transport === 'playing' ? { background: '#15803d', color: '#fff' } : {}) }}
              onClick={(e) => void handlePlay(e.shiftKey)}
              disabled={!ready || !hasClips || (transport !== 'idle' && transport !== 'playing' && !(transport === 'armed' && mode === 'free'))}>
              {transport === 'playing' ? '⏸ Pause' : transport === 'armed' && mode === 'free' ? '▶ Play / ⇧ Count-in' : '▶ Play'}
            </button>
          </div>

          {/* Timeline canvas */}
          <canvas
            ref={canvasRef}
            width={CANVAS_WIDTH}
            height={CANVAS_HEIGHT}
            style={{ display: 'block', cursor: 'crosshair' }}
            onMouseDown={handleCanvasMouseDown}
            onMouseMove={handleCanvasMouseMove}
            onMouseUp={handleCanvasMouseUp}
            onMouseLeave={handleCanvasMouseUp}
          />
          <div style={{ fontSize: 11, color: '#52525b', marginTop: 2 }}>
            Click lane to select · click empty to seek · drag clip to move
          </div>

          {/* Edit buttons */}
          <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button style={btnStyle} onClick={(e) => e.shiftKey ? handleJoin() : handleSplit()} disabled={!canEdit || !selectedClipId}>Split</button>
            <button style={btnStyle} onClick={handleLift} disabled={!canEdit || !selectedClipId}>Lift</button>
            <button style={{ ...btnStyle, ...(clipboard ? { background: '#1d4ed8' } : {}) }} onClick={handleDrop} disabled={!canEdit || !clipboard}>
              Drop{clipboard ? ' ✓' : ''}
            </button>
            <span style={{ borderLeft: '1px solid #3f3f46', margin: '0 4px' }} />
            <button style={btnStyle} onClick={handleUndo} disabled={undoStack.length === 0}>↩ Undo ({undoStack.length})</button>
            <button style={btnStyle} onClick={handleRedo} disabled={redoStack.length === 0}>↪ Redo ({redoStack.length})</button>
          </div>

          {/* Loop controls */}
          <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <button style={btnStyle} onClick={handleSetLoopIn} disabled={!canEdit}>Set In</button>
            <button style={btnStyle} onClick={handleSetLoopOut} disabled={!canEdit}>Set Out</button>
            <button style={{ ...btnStyle, ...(tape.loopEnabled ? { background: '#15803d' } : {}) }} onClick={handleToggleLoop}>
              {tape.loopEnabled ? '⟳ On' : '⟳ Off'}
            </button>
            <button style={btnStyle} onClick={handleLoopFromClip} disabled={!canEdit || !selectedClipId}>Loop from Clip</button>
            {tape.loopOut > tape.loopIn && (
              <span style={{ fontSize: 12, color: '#a1a1aa' }}>
                [{(tape.loopIn / sr).toFixed(2)}s — {(tape.loopOut / sr).toFixed(2)}s]
              </span>
            )}
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
            </div>
          )}
        </>
      )}
    </div>
  );
}
