// Input or master level meter. Reads L/R peak level each animation frame from the
// engine's analyser nodes (bypassing React state for smooth ~60fps motion),
// with a slow release so peaks are visible instead of flickering.

import { useEffect, useRef } from 'react';

interface InputLevelMeterProps {
  analysers: { left: AnalyserNode; right: AnalyserNode } | null;
  side?: 'left' | 'right';
  level?: number;
  mono?: boolean;
}

const RELEASE = 0.85; // per-frame decay once below the current peak
const ORANGE_THRESHOLD = 0.7;
const RED_THRESHOLD = 0.9;

function levelColor(level: number): string {
  if (level >= RED_THRESHOLD) return '#ef4444';
  if (level >= ORANGE_THRESHOLD) return '#f97316';
  return '#22c55e';
}

function peakOf(buffer: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < buffer.length; i++) peak = Math.max(peak, Math.abs(buffer[i]!));
  return peak;
}

export function InputLevelMeter({ analysers, side = 'left', level, mono = false }: InputLevelMeterProps) {
  const leftBarRef = useRef<HTMLDivElement | null>(null);
  const rightBarRef = useRef<HTMLDivElement | null>(null);
  const displayRef = useRef({ left: 0, right: 0 });

  useEffect(() => {
    if (!analysers) return;
    const bufferL = new Float32Array(analysers.left.fftSize);
    const bufferR = new Float32Array(analysers.right.fftSize);
    let raf = 0;

    const tick = () => {
      analysers.left.getFloatTimeDomainData(bufferL);
      analysers.right.getFloatTimeDomainData(bufferR);
      const d = displayRef.current;
      const peakL = peakOf(bufferL);
      const peakR = peakOf(bufferR);
      d.left = peakL > d.left ? peakL : d.left * RELEASE;
      d.right = peakR > d.right ? peakR : d.right * RELEASE;

      if (leftBarRef.current) {
        leftBarRef.current.style.height = `${Math.min(100, d.left * 100)}%`;
        leftBarRef.current.style.background = levelColor(d.left);
      }
      if (rightBarRef.current) {
        rightBarRef.current.style.height = `${Math.min(100, d.right * 100)}%`;
        rightBarRef.current.style.background = levelColor(d.right);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [analysers, mono]);

  return (
    <div className="level-meter" aria-label={`${side === 'left' ? 'Input' : 'Master'} level`}>
      <div className="meter-bars">
        {level !== undefined && (
          <div style={{ position: 'absolute', left: 0, right: 0, bottom: `${Math.max(0, Math.min(1, level)) * 100}%`, height: 1, background: '#a1a1aa', pointerEvents: 'none', zIndex: 1 }} />
        )}
        <div className="meter-channel">
          <div ref={leftBarRef} style={{ width: '100%', height: '0%' }} />
        </div>
        {!mono && (
          <div className="meter-channel">
            <div ref={rightBarRef} style={{ width: '100%', height: '0%' }} />
          </div>
        )}
      </div>
    </div>
  );
}
