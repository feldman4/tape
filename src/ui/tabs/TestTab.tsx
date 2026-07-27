import type { MutableRefObject } from 'react';
import type { LatencyResult } from '../../audio/latencyTest';
import type { NoteLatencyResult } from '../../audio/onsetDetect';
import { btnStyle } from '../btnStyle';

interface TestTabProps {
  ready: boolean;
  handleInit: () => void;
  canEdit: boolean;
  selectedMidiOutputId: string | null;
  latency: LatencyResult | null;
  noteLatency: NoteLatencyResult | null;
  samplesPerPixelRef: MutableRefObject<number>;
  activityLogRef: MutableRefObject<string[]>;
  forceLogUpdate: (fn: (v: number) => number) => void;
  handleLatencyTest: () => void;
  handleOpZLatencyTest: () => void;
  handleSendTestNote: () => void;
  handleSendMidiStart: () => void;
  handleSendMidiStop: () => void;
  midiLatencyMs: number;
  setMidiLatencyMs: (ms: number) => void;
}

export function TestTab({
  ready, handleInit, canEdit, selectedMidiOutputId,
  latency, noteLatency,
  samplesPerPixelRef, activityLogRef, forceLogUpdate,
  handleLatencyTest, handleOpZLatencyTest,
  handleSendTestNote, handleSendMidiStart, handleSendMidiStop,
  midiLatencyMs, setMidiLatencyMs,
}: TestTabProps) {
  if (!ready) {
    return <button onClick={handleInit} style={btnStyle}>Enable Audio + MIDI</button>;
  }

  return (
    <>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
        <button style={btnStyle} onClick={() => void handleLatencyTest()} disabled={!canEdit}>Run Loopback Latency Test</button>
        <button style={btnStyle} onClick={() => void handleOpZLatencyTest()} disabled={!canEdit || !selectedMidiOutputId}>Run OP-Z Latency Test</button>
        <button style={btnStyle} onClick={handleSendTestNote} disabled={!selectedMidiOutputId}>Send Test Note</button>
        <button style={btnStyle} onClick={handleSendMidiStart} disabled={!selectedMidiOutputId}>Send MIDI Start</button>
        <button style={btnStyle} onClick={handleSendMidiStop} disabled={!selectedMidiOutputId}>Send MIDI Stop</button>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, fontSize: 13 }}>
        <label htmlFor="midi-lat">MIDI latency (ms):</label>
        <input
          id="midi-lat"
          type="number"
          min={0}
          max={50}
          step={0.5}
          value={midiLatencyMs}
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            if (!isNaN(v) && v >= 0) setMidiLatencyMs(v);
          }}
          style={{ width: 64, background: '#27272a', color: '#e4e4e7', border: '1px solid #3f3f46', borderRadius: 4, padding: '2px 6px' }}
        />
        <span style={{ color: '#71717a' }}>estimated USB MIDI message delay</span>
      </div>
      {(latency || noteLatency) && (
        <div style={{ fontSize: 13, marginBottom: 8 }}>
          {latency && (
            <div>
              Loopback latency: {latency.latencyMs.toFixed(1)} ms (confidence {latency.confidence.toFixed(2)})
              {latency.confidence < 0.6 && <span style={{ color: '#f59e0b' }}> — low confidence</span>}
            </div>
          )}
          {noteLatency && (
            <div>OP-Z note→sound: {noteLatency.latencyMs !== null ? `${noteLatency.latencyMs.toFixed(1)} ms` : 'not detected'}</div>
          )}
        </div>
      )}
      <div style={{ fontSize: 12, color: '#71717a', marginBottom: 8 }}>
        Zoom: {(samplesPerPixelRef.current / 44100).toFixed(3)} s/px
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
        <span style={{ fontSize: 13, color: '#a1a1aa' }}>Activity log ({activityLogRef.current.length})</span>
        <button style={{ ...btnStyle, fontSize: 11 }} onClick={() => { activityLogRef.current = []; forceLogUpdate((v) => v + 1); }}>Clear</button>
      </div>
      <div style={{ fontFamily: 'monospace', fontSize: 12, color: '#a1a1aa', background: '#18181b', borderRadius: 4, padding: '8px 12px', maxHeight: 360, overflowY: 'auto' }}>
        {activityLogRef.current.length === 0
          ? <span style={{ color: '#52525b' }}>No events yet.</span>
          : activityLogRef.current.slice().reverse().map((entry, i) => (
              <div key={i} style={{ whiteSpace: 'pre', lineHeight: '1.6' }}>{entry}</div>
            ))
        }
      </div>
    </>
  );
}
