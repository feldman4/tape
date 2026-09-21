// App-level settings (device/MIDI/CC assignments, count-in, filter slope).
// Persisted to localStorage — distinct from IndexedDB project storage, since
// these are "app settings" that stay fixed across project switches (see
// docs/manual.md "Projects").

export interface SamplerSettings {
  lastProjectIndex: number;
  midiChannel: number;       // 0-based (0 = MIDI channel 1)
  firstSampleNote: number;   // 0-127; slots occupy [firstSampleNote, firstSampleNote+15]
  deleteNote: number;        // 0-127
  countInOnNote: number;     // 0-127
  countInOffNote: number;    // 0-127
  hpfCc: number;
  lpfCc: number;
  panCc: number;
  levelCc: number;
  masterLevelCc: number;
  masterLevel: number;
  countInEnabled: boolean;
  countInBeats: number;
  recordingTailMs: number;
  recordingLatencyMs: number;
  filterSlopeStages: 1 | 2;  // 12 dB/oct vs 24 dB/oct per filter
}

const STORAGE_KEY = 'loop-pad:settings';

export function defaultSettings(): SamplerSettings {
  return {
    lastProjectIndex: 1,
    midiChannel: 15, // MIDI channel 16 (0-based)
    firstSampleNote: 53, // F3
    deleteNote: 76,
    countInOnNote: 74,
    countInOffNote: 72,
    hpfCc: 1,
    lpfCc: 2,
    panCc: 3,
    levelCc: 4,
    masterLevelCc: 16,
    masterLevel: 1,
    countInEnabled: false,
    countInBeats: 4,
    recordingTailMs: 300,
    recordingLatencyMs: 20,
    filterSlopeStages: 2,
  };
}

export function loadSettings(): SamplerSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultSettings();
    const saved = JSON.parse(raw) as Partial<SamplerSettings> & { countInToggleNote?: number };
    const settings = { ...defaultSettings(), ...saved };
    if (saved.countInOnNote === undefined && saved.countInToggleNote !== undefined) {
      settings.countInOnNote = saved.countInToggleNote;
    }
    return settings;
  } catch {
    return defaultSettings();
  }
}

export function saveSettings(settings: SamplerSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}
