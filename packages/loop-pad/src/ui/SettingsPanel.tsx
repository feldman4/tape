import { btnStyle } from './btnStyle';
import type { SamplerSettings } from '../sampler/settings';
import type { MidiDeviceRef } from '../midi/midiEngine';

interface SettingsPanelProps {
  settings: SamplerSettings;
  onChange: (patch: Partial<SamplerSettings>) => void;
  audioInputs: MediaDeviceInfo[];
  selectedAudioInputId: string | null;
  onSelectAudioInput: (deviceId: string) => void;
  audioInputChannelCount: number;
  selectedAudioInputChannelPairStart: number;
  onSelectAudioInputChannelPair: (start: number) => void;
  audioOutputs: MediaDeviceInfo[];
  selectedAudioOutputId: string;
  onSelectAudioOutput: (deviceId: string) => void;
  audioOutputChannelCount: number;
  selectedAudioOutputChannelPairStart: number;
  onSelectAudioOutputChannelPair: (start: number) => void;
  midiInputs: MidiDeviceRef[];
  selectedMidiInputId: string | null;
  onSelectMidiInput: (deviceId: string) => void;
  midiOutputs: MidiDeviceRef[];
  selectedMidiOutputId: string | null;
  onSelectMidiOutput: (deviceId: string) => void;
  onClearProjectMemory: () => void;
  onClose: () => void;
}

function numberField(
  label: string,
  value: number,
  onChange: (n: number) => void,
  props: { min?: number; max?: number } = {},
) {
  return (
    <label style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13, color: '#a1a1aa' }}>
      {label}
      <input
        type="number"
        min={props.min ?? 0}
        max={props.max ?? 127}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ width: 70, background: '#18181b', border: '1px solid #3f3f46', color: '#e4e4e7', borderRadius: 4, padding: '2px 6px' }}
      />
    </label>
  );
}

export function SettingsPanel({
  settings, onChange, audioInputs, selectedAudioInputId, onSelectAudioInput,
  audioInputChannelCount, selectedAudioInputChannelPairStart, onSelectAudioInputChannelPair,
  audioOutputs, selectedAudioOutputId, onSelectAudioOutput,
  audioOutputChannelCount, selectedAudioOutputChannelPairStart, onSelectAudioOutputChannelPair,
  midiInputs, selectedMidiInputId, onSelectMidiInput,
  midiOutputs, selectedMidiOutputId, onSelectMidiOutput, onClearProjectMemory, onClose,
}: SettingsPanelProps) {
  const stereoPairs = Array.from({ length: Math.floor(audioOutputChannelCount / 2) }, (_, index) => index * 2);
  const inputPairs = Array.from({ length: Math.floor(audioInputChannelCount / 2) }, (_, index) => index * 2);

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#1c1c1f', border: '1px solid #3f3f46', borderRadius: 8,
          padding: 20, width: 320, maxHeight: 'calc(100vh - 40px)', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ margin: 0, fontSize: 14, color: '#e4e4e7' }}>Settings</h3>
          <button style={btnStyle} onClick={onClose}>Close</button>
        </div>
        <label style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13, color: '#a1a1aa' }}>
          Audio Input
          <select value={selectedAudioInputId ?? ''} onChange={(e) => onSelectAudioInput(e.target.value)}>
            <option value="" disabled>None</option>
            {audioInputs.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label || device.deviceId}</option>)}
          </select>
        </label>
        <label style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13, color: '#a1a1aa' }}>
          Input Channels
          <select value={selectedAudioInputChannelPairStart} onChange={(e) => onSelectAudioInputChannelPair(Number(e.target.value))} disabled={inputPairs.length <= 1}>
            {inputPairs.map((start) => <option key={start} value={start}>{start + 1}-{start + 2}</option>)}
          </select>
        </label>
        <label style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13, color: '#a1a1aa' }}>
          Audio Output
          <select value={selectedAudioOutputId} onChange={(e) => onSelectAudioOutput(e.target.value)}>
            <option value="">System default</option>
            {audioOutputs.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label || device.deviceId}</option>)}
          </select>
        </label>
        {stereoPairs.length > 1 && (
          <label style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13, color: '#a1a1aa' }}>
            Output Channels
            <select value={selectedAudioOutputChannelPairStart} onChange={(e) => onSelectAudioOutputChannelPair(Number(e.target.value))}>
              {stereoPairs.map((start) => <option key={start} value={start}>{start + 1}-{start + 2}</option>)}
            </select>
          </label>
        )}
        <label style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13, color: '#a1a1aa' }}>
          MIDI Input
          <select value={selectedMidiInputId ?? ''} onChange={(e) => onSelectMidiInput(e.target.value)}>
            <option value="" disabled>None</option>
            {midiInputs.map((device) => <option key={device.id} value={device.id}>{device.name || device.id}</option>)}
          </select>
        </label>
        <label style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13, color: '#a1a1aa' }}>
          MIDI Output
          <select value={selectedMidiOutputId ?? ''} onChange={(e) => onSelectMidiOutput(e.target.value)}>
            <option value="" disabled>None</option>
            {midiOutputs.map((device) => <option key={device.id} value={device.id}>{device.name || device.id}</option>)}
          </select>
        </label>
        {numberField('MIDI Channel (1-16)', settings.midiChannel + 1, (n) => onChange({ midiChannel: Math.max(0, Math.min(15, n - 1)) }), { min: 1, max: 16 })}
        {numberField('First Sample Note', settings.firstSampleNote, (n) => onChange({ firstSampleNote: n }))}
        {numberField('Delete Note', settings.deleteNote, (n) => onChange({ deleteNote: n }))}
        {numberField('Count-in Toggle Note', settings.countInToggleNote, (n) => onChange({ countInToggleNote: n }))}
        {numberField('HPF Cutoff CC', settings.hpfCc, (n) => onChange({ hpfCc: n }))}
        {numberField('LPF Cutoff CC', settings.lpfCc, (n) => onChange({ lpfCc: n }))}
        {numberField('Pan CC', settings.panCc, (n) => onChange({ panCc: n }))}
        {numberField('Level CC', settings.levelCc, (n) => onChange({ levelCc: n }))}
        {numberField('Count-in Beats', settings.countInBeats, (n) => onChange({ countInBeats: Math.max(1, n) }), { min: 1, max: 32 })}
        {numberField('Recording Tail (ms)', settings.recordingTailMs, (n) => onChange({ recordingTailMs: n }), { min: 0, max: 5000 })}
        <label style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#a1a1aa' }}>
          Filter Slope
          <select
            value={settings.filterSlopeStages}
            onChange={(e) => onChange({ filterSlopeStages: Number(e.target.value) as 1 | 2 })}
            style={{ background: '#18181b', border: '1px solid #3f3f46', color: '#e4e4e7', borderRadius: 4 }}
          >
            <option value={1}>12 dB/oct</option>
            <option value={2}>24 dB/oct</option>
          </select>
        </label>
        <button
          style={{ ...btnStyle, color: '#fca5a5', borderColor: '#7f1d1d', alignSelf: 'flex-start' }}
          onClick={onClearProjectMemory}
        >
          Clear Project Memory
        </button>
      </div>
    </div>
  );
}
