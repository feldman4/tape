// Small display-only dial: a ring gauge (via conic-gradient) plus a label.
// Not interactive — per docs/manual.md, mixer knobs are displays, not controls.

interface MiniKnobProps {
  label: string;
  /** 0..1 fill fraction. */
  value: number;
  color: string;
}

export function MiniKnob({ label, value, color }: MiniKnobProps) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
      <div
        style={{
          width: 22,
          height: 22,
          borderRadius: '50%',
          background: `conic-gradient(${color} ${pct}%, #3f3f46 0)`,
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
