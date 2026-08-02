import { useEffect, useRef, useState } from 'react';
import type React from 'react';
import type { Tape } from '../../tape/model';
import type { TapeAction } from '../tapeActions';
import type { Mode, TransportState } from '../tapeRefs';
import { reelIntentToAction, type ReelSector } from '../tapeIntents';

interface IpadTapeTabProps {
  ready: boolean;
  handleInit: () => void;
  tape: Tape;
  transport: TransportState;
  mode: Mode;
  snap: boolean;
  clickEnabled: boolean;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  viewWidthSamplesRef: React.RefObject<number>;
  dispatch: (action: TapeAction) => void;
  handleToggleClick: () => void;
  setActiveTab: (tab: 'COM' | 'TAPE' | 'MIXER' | 'PROJ' | 'TEST') => void;
}

const tabs = ['TAPE', 'MIXER', 'PROJ', 'COM', 'TEST'] as const;
const laneNumbers = [0, 1, 2, 3] as const;
const REEL_CENTER_Y = 0.4;

function MiniMap({ tape, viewWidthSamples }: { tape: Tape; viewWidthSamples: number }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;

    const width = canvas.width;
    const height = canvas.height;
    let end = Math.max(tape.tapeLength, 1);
    for (const lane of tape.lanes) {
      for (const clip of lane.clips) end = Math.max(end, clip.tapeStart + clip.duration);
    }
    end = Math.max(end, tape.playhead + viewWidthSamples / 2);

    context.clearRect(0, 0, width, height);
    context.fillStyle = '#000000';
    context.fillRect(0, 0, width, height);
    const laneHeight = height / 4;
    for (let laneIndex = 0; laneIndex < 4; laneIndex += 1) {
      for (const clip of tape.lanes[laneIndex]!.clips) {
        const x = clip.tapeStart / end * width;
        const clipWidth = Math.max(2, clip.duration / end * width);
        const muted = clip.muted || tape.lanes[laneIndex]!.muted;
        context.fillStyle = muted ? '#2a2a2a' : laneIndex === tape.activeLane ? '#174a7d' : '#123354';
        context.fillRect(x, laneIndex * laneHeight + 2, clipWidth, laneHeight - 4);
      }
    }
    const windowStart = Math.max(0, tape.playhead - viewWidthSamples / 2);
    const windowEnd = Math.min(end, windowStart + viewWidthSamples);
    context.strokeStyle = '#ffffff';
    context.lineWidth = 2;
    context.strokeRect(windowStart / end * width, 0, (windowEnd - windowStart) / end * width, height);
    if (tape.loopEnabled && tape.loopOut > tape.loopIn) {
      context.fillStyle = '#e9c900';
      context.fillRect(tape.loopIn / end * width, 0, (tape.loopOut - tape.loopIn) / end * width, 3);
    }
    const playhead = tape.playhead / end * width;
    context.strokeStyle = '#c8d0dc';
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(playhead, 0);
    context.lineTo(playhead, height);
    context.stroke();
  }, [tape]);

  return <canvas ref={canvasRef} width={1200} height={100} style={{ width: '100%', height: 'auto', aspectRatio: '12 / 1', display: 'block', transform: 'scaleX(0.7)', transformOrigin: 'center' }} />;
}

function normalizeAngle(delta: number): number {
  if (delta > Math.PI) return delta - Math.PI * 2;
  if (delta < -Math.PI) return delta + Math.PI * 2;
  return delta;
}

export function IpadTapeTab({
  ready,
  handleInit,
  tape,
  transport,
  mode,
  snap,
  clickEnabled,
  canvasRef,
  viewWidthSamplesRef,
  dispatch,
  handleToggleClick,
  setActiveTab,
}: IpadTapeTabProps) {
  const [shiftHeld, setShiftHeld] = useState(false);
  const [reelSector, setReelSector] = useState<ReelSector | null>(null);
  const shiftRef = useRef(false);
  const reelRef = useRef<{ pointerId: number; sector: ReelSector; angle: number; remainder: number } | null>(null);

  const setShift = (next: boolean) => {
    shiftRef.current = next;
    setShiftHeld(next);
  };

  const dispatchShiftAction = (normal: TapeAction, shifted: TapeAction) => {
    dispatch(shiftRef.current ? shifted : normal);
  };

  const handleReelDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!ready || event.pointerType === 'mouse') return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left - rect.width / 2;
    const y = event.clientY - rect.top - rect.height * REEL_CENTER_Y;
    const outerRadius = Math.min(rect.width, rect.height) * 0.47;
    const innerRadius = outerRadius * 0.24;
    const radius = Math.hypot(x, y);
    if (radius < innerRadius || radius > outerRadius) return;

    const sector: ReelSector = y < 0 ? 'playhead' : 'loop';
    reelRef.current = { pointerId: event.pointerId, sector, angle: Math.atan2(y, x), remainder: 0 };
    setReelSector(sector);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleReelMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const reel = reelRef.current;
    if (!reel || reel.pointerId !== event.pointerId) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const angle = Math.atan2(event.clientY - rect.top - rect.height * REEL_CENTER_Y, event.clientX - rect.left - rect.width / 2);
    reel.remainder += normalizeAngle(angle - reel.angle) / (Math.PI / 18);
    reel.angle = angle;
    const ticks = Math.trunc(reel.remainder);
    if (ticks === 0) return;
    reel.remainder -= ticks;
    dispatch(reelIntentToAction({ sector: reel.sector, delta: ticks, shift: shiftRef.current }));
  };

  const endReel = (event: React.PointerEvent<HTMLDivElement>) => {
    if (reelRef.current?.pointerId !== event.pointerId) return;
    reelRef.current = null;
    setReelSector(null);
  };

  const touchButtonStyle = (active = false): React.CSSProperties => ({
    appearance: 'none', border: '1px solid #35404e', borderRadius: 0, background: active ? '#293d88' : '#000000',
    color: '#e8edf4', fontSize: 16, fontWeight: 700, letterSpacing: 0, touchAction: 'none', userSelect: 'none', WebkitUserSelect: 'none', minWidth: 0,
  });

  if (!ready) {
    return <button onClick={handleInit} style={{ ...touchButtonStyle(), minHeight: 72, margin: 24 }}>Enable Audio + MIDI</button>;
  }

  return (
    <div style={{ background: '#000000', color: '#e8edf4', width: '100vw', marginLeft: 'calc(50% - 50vw)', height: '100dvh', minHeight: 540, boxSizing: 'border-box', display: 'grid', gridTemplateColumns: 'minmax(104px, 14vw) minmax(0, 1fr) minmax(104px, 14vw)', gridTemplateRows: '82px minmax(0, 1fr) 74px', gap: 8, fontFamily: 'sans-serif', touchAction: 'none', overscrollBehavior: 'none' }}>
      <button onPointerDown={() => dispatch({ type: 'record' })} style={touchButtonStyle(transport === 'recording' || transport === 'armed')}>REC</button>
      <div />
      <button onPointerDown={() => dispatchShiftAction({ type: 'toggleLoop' }, { type: 'loopFromClip' })} style={touchButtonStyle(tape.loopEnabled)}>LOOP</button>

      <div style={{ minHeight: 0, display: 'grid', gridTemplateRows: 'repeat(4, 1fr)', border: '1px solid #35404e' }}>
        {laneNumbers.map((lane) => (
          <button key={lane} onPointerDown={() => dispatchShiftAction({ type: 'selectLane', lane }, { type: 'toggleMuteLane', lane })} style={touchButtonStyle(tape.activeLane === lane)}>
            TAPE {lane + 1}
          </button>
        ))}
      </div>

      <div style={{ position: 'relative', minHeight: 0, display: 'grid', gridTemplateRows: 'auto 122px auto', alignContent: 'start', gap: 8 }}>
        <canvas ref={canvasRef} width={1240} height={268} style={{ width: '100%', height: 'auto', aspectRatio: '620 / 134', display: 'block', background: '#000000' }} />
        <div style={{ position: 'relative', zIndex: 3, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 8, padding: '40px 0' }}>
          <button onPointerDown={() => dispatch({ type: 'stop' })} style={{ ...touchButtonStyle(), height: 34, padding: '0 18px' }}>STOP</button>
          <button onPointerDown={() => dispatch({ type: 'play' })} style={{ ...touchButtonStyle(transport === 'playing'), height: 34, padding: '0 18px' }}>PLAY</button>
        </div>
        <MiniMap tape={tape} viewWidthSamples={viewWidthSamplesRef.current} />
        <div
          onPointerDown={handleReelDown}
          onPointerMove={handleReelMove}
          onPointerUp={endReel}
          onPointerCancel={endReel}
          style={{ position: 'absolute', inset: '0 4% 0', touchAction: 'none', zIndex: 2 }}
        >
          {reelSector && (
            <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
              <div style={{ width: 'min(70%, calc(100% - 12px))', aspectRatio: '1', position: 'absolute', left: '50%', top: '40%', transform: 'translate(-50%, -50%)', border: '1px solid rgba(184, 197, 211, 0.7)', borderRadius: '50%' }}>
                <div style={{ position: 'absolute', width: '24%', aspectRatio: '1', left: '38%', top: '38%', border: '1px solid rgba(157, 172, 189, 0.55)', borderRadius: '50%' }} />
                <div style={{ position: 'absolute', left: 0, right: 0, top: '50%', borderTop: '1px solid rgba(184, 197, 211, 0.7)' }} />
              </div>
            </div>
          )}
        </div>
      </div>

      <div style={{ minHeight: 0, display: 'grid', gridTemplateRows: 'repeat(4, 1fr)', border: '1px solid #35404e' }}>
        <button onPointerDown={() => dispatchShiftAction({ type: 'lift' }, { type: 'liftAll' })} style={touchButtonStyle()}>LIFT</button>
        <button onPointerDown={() => dispatchShiftAction({ type: 'drop' }, { type: 'mergeDrop' })} style={touchButtonStyle()}>DROP</button>
        <button onPointerDown={() => dispatchShiftAction({ type: 'split' }, { type: 'join' })} style={touchButtonStyle()}>SPLIT</button>
        <button onPointerDown={() => dispatchShiftAction({ type: 'undo' }, { type: 'redo' })} style={touchButtonStyle()}>UNDO</button>
      </div>

      <button onPointerDown={() => setShift(true)} onPointerUp={() => setShift(false)} onPointerCancel={() => setShift(false)} style={touchButtonStyle(shiftHeld)}>SHIFT</button>
      <footer style={{ minWidth: 0, border: '1px solid #35404e', display: 'grid', gridTemplateColumns: 'auto auto auto 1fr', alignItems: 'center', gap: 8, padding: '0 12px' }}>
        <button onPointerDown={() => dispatch({ type: 'toggleMode' })} style={{ ...touchButtonStyle(mode === 'free'), height: 38, padding: '0 16px' }}>{mode.toUpperCase()}</button>
        <button onPointerDown={() => dispatch({ type: 'toggleSnap' })} style={{ ...touchButtonStyle(snap), height: 38, padding: '0 16px' }}>SNAP</button>
        <button onPointerDown={handleToggleClick} style={{ ...touchButtonStyle(clickEnabled), height: 38, padding: '0 16px' }}>CLICK</button>
        <div style={{ display: 'flex', justifyContent: 'center', gap: 8 }}>
          {tabs.map((tab) => <button key={tab} onPointerDown={() => setActiveTab(tab)} style={{ ...touchButtonStyle(tab === 'TAPE'), height: 38, padding: '0 15px' }}>{tab}</button>)}
        </div>
      </footer>
      <button onPointerDown={() => setShift(true)} onPointerUp={() => setShift(false)} onPointerCancel={() => setShift(false)} style={touchButtonStyle(shiftHeld)}>SHIFT</button>
    </div>
  );
}
