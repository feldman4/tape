import { btnStyle } from '../btnStyle';

interface ComTabProps {
  ready: boolean;
  handleInit: () => void;
  canEdit: boolean;
  audioDevices: MediaDeviceInfo[];
  selectedAudioDeviceId: string | null;
  handleAudioDeviceChange: (id: string) => void;
  audioOutputDevices: MediaDeviceInfo[];
  selectedAudioOutputId: string;
  handleAudioOutputChange: (id: string) => void;
  midiInputs: { id: string; name: string | null }[];
  selectedMidiInputId: string;
  handleMidiInputChange: (id: string) => void;
  midiOutputs: { id: string; name: string | null }[];
  selectedMidiOutputId: string | null;
  handleMidiOutputChange: (id: string) => void;
  inputLatencyMs: number;
  setInputLatencyMs: (ms: number) => void;
  outputLatencyMs: number;
  setOutputLatencyMs: (ms: number) => void;
  midiLatencyMs: number;
  setMidiLatencyMs: (ms: number) => void;
}

export function ComTab({
  ready,
  handleInit,
  canEdit,
  audioDevices,
  selectedAudioDeviceId,
  handleAudioDeviceChange,
  audioOutputDevices,
  selectedAudioOutputId,
  handleAudioOutputChange,
  midiInputs,
  selectedMidiInputId,
  handleMidiInputChange,
  midiOutputs,
  selectedMidiOutputId,
  handleMidiOutputChange,
  inputLatencyMs,
  setInputLatencyMs,
  outputLatencyMs,
  setOutputLatencyMs,
  midiLatencyMs,
  setMidiLatencyMs,
}: ComTabProps) {
  if (!ready) {
    return <button onClick={handleInit} style={btnStyle}>Enable Audio + MIDI</button>;
  }

  return (
    <>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 12 }}>
        <label>Audio in:
          <select value={selectedAudioDeviceId ?? ''} onChange={(e) => handleAudioDeviceChange(e.target.value)} disabled={!canEdit} style={{ marginLeft: 6 }}>
            {audioDevices.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || d.deviceId}</option>)}
          </select>
        </label>
        <label>Audio out:
          <select value={selectedAudioOutputId} onChange={(e) => void handleAudioOutputChange(e.target.value)} style={{ marginLeft: 6 }}>
            <option value="">System default</option>
            {audioOutputDevices.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || d.deviceId}</option>)}
          </select>
        </label>
        <label>MIDI in:
          <select value={selectedMidiInputId} onChange={(e) => handleMidiInputChange(e.target.value)} disabled={!canEdit} style={{ marginLeft: 6 }}>
            <option value="all">All inputs</option>
            {midiInputs.map((i) => <option key={i.id} value={i.id}>{i.name || i.id}</option>)}
          </select>
        </label>
        <label>MIDI out:
          <select value={selectedMidiOutputId ?? ''} onChange={(e) => handleMidiOutputChange(e.target.value)} disabled={!canEdit} style={{ marginLeft: 6 }}>
            <option value="" disabled>None</option>
            {midiOutputs.map((o) => <option key={o.id} value={o.id}>{o.name || o.id}</option>)}
          </select>
        </label>
      </div>
      <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <label style={{ fontSize: 13, color: '#a1a1aa', display: 'flex', gap: 6, alignItems: 'center' }}>
          Input latency
          <input
            type="number"
            max={500}
            step={1}
            value={Math.round(inputLatencyMs)}
            onChange={(e) => setInputLatencyMs(Number(e.target.value))}
            style={{ width: 72, padding: '2px 6px', background: '#27272a', border: '1px solid #3f3f46', color: '#e4e4e7', borderRadius: 4, fontSize: 13 }}
          />
          <span style={{ color: '#52525b' }}>ms — mic capture to samples available</span>
        </label>
      </div>
      <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <label style={{ fontSize: 13, color: '#a1a1aa', display: 'flex', gap: 6, alignItems: 'center' }}>
          Output latency
          <input
            type="number"
            max={500}
            step={1}
            value={outputLatencyMs}
            onChange={(e) => setOutputLatencyMs(Number(e.target.value))}
            style={{ width: 72, padding: '2px 6px', background: '#27272a', border: '1px solid #3f3f46', color: '#e4e4e7', borderRadius: 4, fontSize: 13 }}
          />
          <span style={{ color: '#52525b' }}>ms — shifts clips recorded in free mode back. Also compensates playback of tape</span>
        </label>
      </div>
      <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <label style={{ fontSize: 13, color: '#a1a1aa', display: 'flex', gap: 6, alignItems: 'center' }}>
          MIDI latency
          <input
            type="number"
            max={500}
            step={1}
            value={Math.round(midiLatencyMs)}
            onChange={(e) => setMidiLatencyMs(Math.round(Number(e.target.value)))}
            style={{ width: 72, padding: '2px 6px', background: '#27272a', border: '1px solid #3f3f46', color: '#e4e4e7', borderRadius: 4, fontSize: 13 }}
          />
          <span style={{ color: '#52525b' }}>ms — MIDI device to tape playback alignment</span>
        </label>
      </div>
    </>
  );
}
