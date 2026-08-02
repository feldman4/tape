import type { MutableRefObject } from 'react';
import type { LatencyResult } from '../../audio/latencyTest';
import type { NoteLatencyResult } from '../../audio/onsetDetect';
import { btnStyle } from '../btnStyle';
import { CANVAS_WIDTH } from '../canvasConstants';

export type InputLatCalResult =
  | { offsetMs: number; beatsDetected: number; totalBeats: number; confidence: 'high' | 'medium' | 'low' }
  | { error: string };

interface TestTabProps {
  ready: boolean;
  handleInit: () => void;
  canEdit: boolean;
  selectedMidiOutputId: string | null;
  latency: LatencyResult | null;
  noteLatency: NoteLatencyResult | null;
  viewWidthSamplesRef: MutableRefObject<number>;
  activityLogRef: MutableRefObject<string[]>;
  forceLogUpdate: (fn: (v: number) => number) => void;
  handleLatencyTest: () => void;
  handleOpZLatencyTest: () => void;
  handleSendTestNote: () => void;
  handleSendMidiStart: () => void;
  handleSendMidiStop: () => void;
  handleMidiStartToNoteTest: () => void;
  midiStartToNoteOffset: { offsetMs: number } | { error: string } | null;
  testingMidiStartToNote: boolean;
  midiLatencyMs: number;
  setMidiLatencyMs: (ms: number) => void;
  // Input latency calibration
  inputLatencyMs: number;
  inputLatCal: InputLatCalResult | null;
  calibratingInputLat: boolean;
  onCalibrateInputLat: () => void;
  // Output latency
  outputLatencyMs: number;
  setOutputLatencyMs: (ms: number) => void;
}

export function TestTab({
  ready, handleInit, canEdit, selectedMidiOutputId,
  latency, noteLatency,
  viewWidthSamplesRef, activityLogRef, forceLogUpdate,
  handleLatencyTest, handleOpZLatencyTest,
  handleSendTestNote, handleSendMidiStart, handleSendMidiStop, handleMidiStartToNoteTest,
  midiStartToNoteOffset, testingMidiStartToNote,
  midiLatencyMs, setMidiLatencyMs,
  inputLatencyMs, inputLatCal, calibratingInputLat, onCalibrateInputLat,
  outputLatencyMs, setOutputLatencyMs,
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
        <button style={btnStyle} onClick={handleMidiStartToNoteTest} disabled={testingMidiStartToNote || !selectedMidiOutputId}>
          {testingMidiStartToNote ? 'Waiting for MIDI...' : 'Test MIDI Start→Note'}
        </button>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, fontSize: 13 }}>
        <label htmlFor="midi-lat">MIDI latency (ms):</label>
        <input
          id="midi-lat"
          type="number"
          max={50}
          step={1}
          value={Math.round(midiLatencyMs)}
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            if (!isNaN(v)) setMidiLatencyMs(Math.round(v));
          }}
          style={{ width: 64, background: '#27272a', color: '#e4e4e7', border: '1px solid #3f3f46', borderRadius: 4, padding: '2px 6px' }}
        />
        <span style={{ color: '#71717a' }}>estimated USB MIDI message delay</span>
      </div>

      {/* ---- Input latency calibration ---- */}
      <div style={{ marginBottom: 12, padding: '10px 12px', background: '#18181b', borderRadius: 6, border: '1px solid #3f3f46' }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#e4e4e7', marginBottom: 4 }}>Input Latency Calibration</div>
        <div style={{ fontSize: 12, color: '#71717a', marginBottom: 8 }}>
          Start OP-Z metronome with MIDI Start, then click Calibrate. Records incoming clicks and measures
          onset latency relative to MIDI Start message timing.
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            style={btnStyle}
            onClick={onCalibrateInputLat}
            disabled={calibratingInputLat}>
            {calibratingInputLat ? 'Waiting for MIDI Start…' : 'Calibrate Input Latency'}
          </button>
        </div>
        {inputLatCal && 'error' in inputLatCal && (
          <div style={{ fontSize: 12, color: '#f87171', marginTop: 6 }}>⚠ {inputLatCal.error}</div>
        )}
        {inputLatCal && !('error' in inputLatCal) && (
          <div style={{ fontSize: 12, color: '#a1a1aa', marginTop: 6 }}>
            Offset:{' '}
            <b style={{ color: '#e4e4e7' }}>{inputLatCal.offsetMs.toFixed(1)} ms</b>
            {' '}({inputLatCal.beatsDetected}/{inputLatCal.totalBeats} beats,{' '}
            confidence:{' '}
            <span style={{ color: inputLatCal.confidence === 'high' ? '#4ade80' : inputLatCal.confidence === 'medium' ? '#fbbf24' : '#f87171' }}>
              {inputLatCal.confidence}
            </span>)
            {' '}— applied as L_in ✓
          </div>
        )}
        {!inputLatCal && (
          <div style={{ fontSize: 12, color: '#52525b', marginTop: 6 }}>
            Current L_in: {Math.round(inputLatencyMs)} ms
          </div>
        )}
      </div>

      {/* ---- Output latency ---- */}
      <div style={{ marginBottom: 12, padding: '10px 12px', background: '#18181b', borderRadius: 6, border: '1px solid #3f3f46' }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#e4e4e7', marginBottom: 4 }}>Output Latency</div>
        <div style={{ fontSize: 12, color: '#71717a', marginBottom: 8 }}>
          After calibrating input latency, record the metronome again.
          Adjust until playback of those clips aligns with what you hear via hardware monitoring.
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <label htmlFor="out-lat" style={{ fontSize: 13 }}>Output latency (ms):</label>
          <input
            id="out-lat"
            type="number"
            max={300}
            step={1}
            value={outputLatencyMs}
            onChange={(e) => {
              const v = parseFloat(e.target.value);
              if (!isNaN(v)) setOutputLatencyMs(v);
            }}
            style={{ width: 72, background: '#27272a', color: '#e4e4e7', border: '1px solid #3f3f46', borderRadius: 4, padding: '2px 6px' }}
          />
          <span style={{ fontSize: 12, color: '#71717a' }}>used to start playback early so audio reaches ears on the beat</span>
        </div>
      </div>
      {(latency || noteLatency || midiStartToNoteOffset) && (
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
          {midiStartToNoteOffset && 'error' in midiStartToNoteOffset && (
            <div style={{ color: '#f87171' }}>MIDI Start→Note: ⚠ {midiStartToNoteOffset.error}</div>
          )}
          {midiStartToNoteOffset && !('error' in midiStartToNoteOffset) && (
            <div style={{ color: '#e4e4e7' }}>MIDI Start→Note: <b>{midiStartToNoteOffset.offsetMs.toFixed(1)} ms</b> offset</div>
          )}
        </div>
      )}
      <div style={{ fontSize: 12, color: '#71717a', marginBottom: 8 }}>
        Zoom: {((viewWidthSamplesRef.current / CANVAS_WIDTH) / 44100).toFixed(3)} s/px
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
