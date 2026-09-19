// Stereo input level meter — a narrow two-column bar fixed to the left edge
// of the screen. Reads L/R peak level each animation frame directly from the
// engine's analyser nodes (bypassing React state for smooth ~60fps motion),
// with a slow release so peaks are visible instead of flickering.

import { useEffect, useRef } from 'react';

interface InputLevelMeterProps {
  analysers: { left: AnalyserNode; right: AnalyserNode } | null;
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

export function InputLevelMeter({ analysers }: InputLevelMeterProps) {
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
  }, [analysers]);

  return (
    <div
      style={{
        position: 'fixed', left: 0, top: 0, bottom: 0, width: 16,
        display: 'flex', gap: 2, padding: '8px 3px', background: '#0a0a0b',
        boxSizing: 'border-box', zIndex: 5,
      }}
      aria-label="Input level"
    >
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column-reverse', background: '#18181b', borderRadius: 2, overflow: 'hidden' }}>
        <div ref={leftBarRef} style={{ width: '100%', height: '0%' }} />
      </div>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column-reverse', background: '#18181b', borderRadius: 2, overflow: 'hidden' }}>
        <div ref={rightBarRef} style={{ width: '100%', height: '0%' }} />
      </div>
    </div>
  );
}
