import { useEffect, useMemo, useRef } from 'react';
import type { Slot } from '../sampler/model';

interface SampleDisplayProps {
  slot: Slot | null;
  progress: number | null;
  tick: number;
  mixerEnabled: boolean;
  bpm: number | null;
}

export function SampleDisplay({ slot, progress, tick, mixerEnabled, bpm }: SampleDisplayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sample = slot?.sample;
  const samplePeaks = useMemo(() => {
    if (!sample) return [];
    const { left, right } = sample.samples;
    const count = Math.min(1600, left.length);
    const result = new Array<number>(count).fill(0);
    for (let i = 0; i < left.length; i++) {
      const bucket = Math.floor(i * count / left.length);
      result[bucket] = Math.max(result[bucket]!, Math.abs(left[i]!), Math.abs(right[i]!));
    }
    return result;
  }, [sample]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const draw = () => {
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.scale(dpr, dpr);
      const usable = Math.max(0, width - 1);
      const duration = sample ? sample.samples.left.length / sample.sampleRate : 0;
      if (bpm !== null && Number.isFinite(bpm) && bpm > 0 && duration > 0 && usable > 0 && slot?.activity.kind !== 'recording') {
        const beatDuration = 60 / bpm;
        const beatCount = Math.ceil(duration / beatDuration);
        const beatStep = beatCount > usable ? Math.ceil(beatCount / usable / 4) * 4 : 1;
        ctx.lineWidth = 1;
        for (let i = 0; i < beatCount; i += beatStep) {
          const x = Math.round(usable * i * beatDuration / duration) + 0.5;
          ctx.strokeStyle = i % 4 === 0 ? '#788183' : '#525a5c';
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, height);
          ctx.stroke();
        }
      }
      const peaks = slot?.activity.kind === 'recording' ? slot.recordingPeaks : samplePeaks;
      if (peaks.length) {
        const length = peaks.length;
        const values = new Float32Array(Math.max(1, width));
        let max = 0.05;
        for (let x = 0; x < values.length; x++) {
          const start = Math.floor(x * length / values.length);
          const end = Math.max(start + 1, Math.floor((x + 1) * length / values.length));
          let peak = 0;
          for (let i = start; i < Math.min(end, length); i++) {
            peak = Math.max(peak, peaks[i]!);
          }
          values[x] = peak;
          max = Math.max(max, peak);
        }
        ctx.strokeStyle = slot?.activity.kind === 'recording' ? '#ef4444' : slot?.sample?.takeStatus === 'unfinalized' ? '#f59e0b' : '#008cff';
        ctx.beginPath();
        for (let x = 0; x < values.length; x++) {
          const amplitude = values[x]! / max * height * 0.42;
          ctx.moveTo(x, height / 2 - amplitude);
          ctx.lineTo(x, height / 2 + amplitude);
        }
        ctx.stroke();
        ctx.strokeStyle = '#f4e900';
        ctx.lineWidth = 2;
        for (const x of [0, usable]) {
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, height);
          ctx.stroke();
        }
        if (progress !== null) {
          const x = usable * Math.max(0, Math.min(1, progress));
          ctx.strokeStyle = '#fff';
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, height);
          ctx.stroke();
        }
      }
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [slot, sample, progress, tick, samplePeaks, bpm]);

  const mixer = slot?.mixer;
  const pan = mixer?.pan ?? 0;
  return (
    <section className="sample-display" aria-label="Selected sample">
      <canvas ref={canvasRef} className="sample-waveform" aria-label={slot?.sample ? 'Selected sample waveform' : 'No selected sample waveform'} />
      <div className="mixer-displays" style={{ opacity: mixer && mixerEnabled ? 1 : 0.35 }} aria-label="Selected sample mixer">
        <div className="mixer-meter" aria-label={`Level ${Math.round((mixer?.level ?? 0) * 100)}%`}><span>LEVEL</span><i style={{ width: `${(mixer?.level ?? 0) * 100}%` }} /></div>
        <div className="mixer-meter" aria-label={`Pan ${Math.round(pan * 100)}%`}><span>PAN</span><i style={{ left: `${50 + Math.min(0, pan) * 50}%`, width: `${Math.abs(pan) * 50}%` }} /></div>
        <div className="mixer-meter filter-meter" aria-label={`HPF ${Math.round((mixer?.hpfCutoff ?? 0) * 100)}%, LPF ${Math.round((mixer?.lpfCutoff ?? 1) * 100)}%`}>
          <span>FILTER</span>
          <i style={{ left: `${(mixer?.hpfCutoff ?? 0) * 100}%`, right: `${(1 - (mixer?.lpfCutoff ?? 1)) * 100}%` }} />
        </div>
      </div>
    </section>
  );
}
