// Small display-only dial: a ring gauge (via conic-gradient) plus a label.
// Not interactive — per docs/manual.md, mixer knobs are displays, not controls.

interface MiniKnobProps {
  label: string;
  /** 0..1 fill fraction, or -1..1 for a bipolar sweep. */
  value: number;
  color: string;
  sweep?: 'full' | 'bipolar';
}

export function MiniKnob({ label, value, color, sweep = 'full' }: MiniKnobProps) {
  const clampedValue = Math.max(0, Math.min(1, value));
  const pct = clampedValue * 100;
  const panValue = Math.max(-1, Math.min(1, value));
  const panFillEnd = panValue * 180;
  const background = sweep === 'bipolar'
    ? panValue >= 0
      ? `conic-gradient(${color} 0deg ${panFillEnd}deg, #3f3f46 ${panFillEnd}deg 360deg)`
      : `conic-gradient(#3f3f46 0deg ${360 + panFillEnd}deg, ${color} ${360 + panFillEnd}deg 360deg)`
    : `conic-gradient(${color} ${pct}%, #3f3f46 0)`;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
      <div
        style={{
          width: 22,
          height: 22,
          borderRadius: '50%',
          background,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <div style={{ width: 12, height: 12, borderRadius: '50%', background: '#18181b' }} />
      </div>
      <span style={{ fontSize: 9, color: '#71717a', letterSpacing: 0.5 }}>{label}</span>
    </div>
  );
}
