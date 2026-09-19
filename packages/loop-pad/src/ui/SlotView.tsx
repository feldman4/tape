import { SlotRing } from './SlotRing';
import { MiniKnob } from './MiniKnob';
import type { Slot } from '../sampler/model';

interface SlotViewProps {
  slot: Slot;
  index: number;
  firstNote: number;
  progress: number | null;
  tick: number;
  active: boolean;
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function noteName(note: number): string {
  return `${NOTE_NAMES[note % 12]}${Math.floor(note / 12) - 1}`;
}

export function SlotView({ slot, index, firstNote, progress, tick, active }: SlotViewProps) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 8,
        padding: 12,
        background: '#1c1c1f',
        border: active ? '1px solid #52525b' : '1px solid #27272a',
        borderRadius: 8,
      }}
    >
      <span style={{ fontSize: 10, color: '#52525b' }}>{noteName(firstNote + index)}</span>
      <SlotRing slot={slot} progress={progress} tick={tick} />
      <div style={{ display: 'flex', gap: 10 }}>
        <MiniKnob label="LEV" value={slot.mixer.level} color="#3b82f6" />
        <MiniKnob label="PAN" value={(slot.mixer.pan + 1) / 2} color="#3b82f6" />
        <MiniKnob label="LPF" value={slot.mixer.lpfCutoff} color="#3b82f6" />
        <MiniKnob label="HPF" value={slot.mixer.hpfCutoff} color="#3b82f6" />
      </div>
    </div>
  );
}
