import { useLayoutEffect, useRef, useState } from 'react';
import type { Slot } from '../sampler/model';
import type { SamplerSettings } from '../sampler/settings';
import { SlotView } from './SlotView';

interface KeyboardProps {
  slots: Slot[];
  settings: SamplerSettings;
  progress: (number | null)[];
  tick: number;
  selectedSlot: number | null;
  flashingSlots: Set<number>;
  bank: number;
}

// The OP-Z keyboard starts on F; these are its white and numbered black keys.
const WHITE_OFFSETS = [0, 2, 4, 6, 7, 9, 11, 12, 14, 16, 18, 19, 21, 23];
const BLACK_OFFSETS = [1, 3, 5, 8, 10, 13, 15, 17, 20, 22];
const BLACK_AFTER_WHITE = [0, 1, 2, 4, 5, 7, 8, 9, 11, 12];

const KEYS = [
  ...WHITE_OFFSETS.map((offset, index) => ({ offset, x: (index + 0.5) / WHITE_OFFSETS.length * 100, black: false, number: undefined })),
  ...BLACK_OFFSETS.map((offset, index) => ({ offset, x: (BLACK_AFTER_WHITE[index]! + 1) / WHITE_OFFSETS.length * 100, black: true, number: index + 1 })),
].sort((a, b) => a.offset - b.offset);

interface Role {
  label: string;
  note: number;
  x: number;
  black: boolean;
}

function Callouts({ roles, side }: { roles: Role[]; side: 'top' | 'bottom' }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1);
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const updateWidth = () => setWidth(container.getBoundingClientRect().width);
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const sorted = [...roles].sort((a, b) => a.x - b.x);
  const margin = Math.min(32, width / 2);
  const spacing = Math.min(width > 800 ? 68 : 60, (width - margin * 2) / Math.max(1, sorted.length - 1));
  const labelPositions = sorted.map((role) => Math.min(width - margin, role.x * width / 100));
  for (let i = labelPositions.length - 2; i >= 0; i--) {
    labelPositions[i] = Math.min(labelPositions[i]!, labelPositions[i + 1]! - spacing);
  }
  const shift = Math.max(0, margin - (labelPositions[0] ?? margin));
  return (
    <div ref={containerRef} className={`key-callouts key-callouts-${side}`}>
      <svg viewBox={`0 0 ${width} 30`} preserveAspectRatio="none" aria-hidden="true">
        {sorted.map((role, i) => {
          const labelX = labelPositions[i]! + shift;
          const keyX = role.x * width / 100;
          const path = side === 'top'
            ? `M ${labelX} 10 V ${12 + i * 2} H ${keyX} V 30`
            : `M ${keyX} 0 V ${5 + i * 2} H ${labelX} V 20`;
          return <path key={`${role.label}-${role.note}`} d={path} />;
        })}
      </svg>
      {sorted.map((role, i) => (
        <span key={`${role.label}-${role.note}`} className="key-callout-label" data-role-note={role.note} title={`${role.label}: MIDI ${role.note}`} style={{ left: `${labelPositions[i]! + shift}px` }}>
          {role.label}
        </span>
      ))}
    </div>
  );
}

export function Keyboard({ slots, settings, progress, tick, selectedSlot, flashingSlots, bank }: KeyboardProps) {
  const assignments = [
    { label: 'COUNT OFF', note: settings.countInOffNote },
    { label: 'COUNT ON', note: settings.countInOnNote },
    { label: 'CHANNEL', note: settings.channelSwitchNote },
    { label: 'ONE-SHOT', note: settings.oneShotModeNote },
    { label: 'DELETE', note: settings.deleteNote },
    { label: 'TAKE', note: settings.takeModeNote },
  ];
  const roles: Role[] = [];
  const outside: typeof assignments = [];
  for (const assignment of assignments) {
    const key = KEYS.find((item) => settings.firstSampleNote + item.offset === assignment.note);
    if (key) roles.push({ ...assignment, x: key.x, black: key.black });
    else outside.push(assignment);
  }

  return (
    <div className="keyboard-diagram">
      <Callouts roles={roles.filter((role) => role.black)} side="top" />
      <div className="slot-strip">
        <div className="slots">
          {KEYS.map((key) => (
            <div key={key.offset} className={`key-position ${key.black ? 'key-position-black' : 'key-position-white'}`} style={{ left: `${key.x}%` }}>
              {key.offset < slots.length ? (
                <SlotView
                  index={key.offset}
                  slot={slots[key.offset]!}
                  firstNote={settings.firstSampleNote}
                  progress={progress[key.offset] ?? null}
                  tick={tick}
                  selected={selectedSlot === key.offset}
                  flashing={flashingSlots.has(bank * slots.length + key.offset)}
                  blackKey={key.number}
                />
              ) : (
                <div className={`slot ${key.black ? 'slot-black' : ''}`} aria-label={`MIDI note ${settings.firstSampleNote + key.offset}`}>
                  <div className="slot-face">{key.number !== undefined && <span>{key.number % 10}</span>}</div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
      <Callouts roles={roles.filter((role) => !role.black)} side="bottom" />
      {outside.length > 0 && (
        <div className="off-keyboard-roles">
          {outside.map(({ label, note }) => `${label}: MIDI ${note}`).join(' · ')} (outside shown keys)
        </div>
      )}
    </div>
  );
}
