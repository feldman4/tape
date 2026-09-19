// App-level settings (device/MIDI/CC assignments, count-in, filter slope).
// Persisted to localStorage — distinct from IndexedDB project storage, since
// these are "app settings" that stay fixed across project switches (see
// docs/manual.md "Projects").

export interface SamplerSettings {
  midiChannel: number;       // 0-based (0 = MIDI channel 1)
  firstSampleNote: number;   // 0-127; slots occupy [firstSampleNote, firstSampleNote+15]
  deleteNote: number;        // 0-127
  countInToggleNote: number; // 0-127
  hpfCc: number;
  lpfCc: number;
  panCc: number;
  levelCc: number;
  countInEnabled: boolean;
  countInBeats: number;
  recordingTailMs: number;
  filterSlopeStages: 1 | 2;  // 12 dB/oct vs 24 dB/oct per filter
}

const STORAGE_KEY = 'loop-pad:settings';

export function defaultSettings(): SamplerSettings {
  return {
    midiChannel: 15, // MIDI channel 16 (0-based)
    firstSampleNote: 53, // F3
    deleteNote: 76,
    countInToggleNote: 74,
    hpfCc: 1,
    lpfCc: 2,
    panCc: 3,
    levelCc: 4,
    countInEnabled: false,
    countInBeats: 4,
    recordingTailMs: 300,
    filterSlopeStages: 2,
  };
}

export function loadSettings(): SamplerSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultSettings();
    return { ...defaultSettings(), ...(JSON.parse(raw) as Partial<SamplerSettings>) };
  } catch {
    return defaultSettings();
  }
}

export function saveSettings(settings: SamplerSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}
