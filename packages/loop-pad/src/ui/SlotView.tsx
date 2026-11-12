import { SlotRing } from './SlotRing';
import { getSlotDisplayState, type Slot } from '../sampler/model';

interface SlotViewProps {
  slot: Slot;
  index: number;
  firstNote: number;
  progress: number | null;
  tick: number;
  selected: boolean;
  flashing: boolean;
  blackKey?: number;
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function SlotView({ slot, index, firstNote, progress, tick, selected, flashing, blackKey }: SlotViewProps) {
  const note = firstNote + index;
  const noteName = `${NOTE_NAMES[note % 12]}${Math.floor(note / 12) - 1}`;
  const state = getSlotDisplayState(slot);
  return (
    <div
      className={`slot ${blackKey !== undefined ? 'slot-black' : ''} ${selected ? 'slot-selected' : ''} ${flashing ? 'slot-flashing' : ''}`}
      data-slot-index={index}
      data-midi-note={note}
      data-note-flashing={flashing || undefined}
      aria-label={`Slot ${index + 1}, ${noteName}, ${state}${selected ? ', selected' : ''}`}
      title={`Slot ${index + 1}: ${noteName} (${state})`}
    >
      <SlotRing slot={slot} progress={progress} tick={tick} />
      <div className="slot-face">{blackKey !== undefined && <span>{blackKey % 10}</span>}</div>
    </div>
  );
}
