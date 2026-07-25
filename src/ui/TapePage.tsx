// Stage 0 spike UI: a single-lane Tape page wiring together the AudioEngine,
// SyncEngine, AudioPool, and recording finalization to let us test whether
// Free and Sync record modes are usable (latency, drift, beat accuracy).

import { useCallback, useEffect, useRef, useState } from 'react';
import { AudioEngine } from '../audio/audioEngine';
import { AudioPool } from '../audio/audioPool';
import { measureLatency, type LatencyResult } from '../audio/latencyTest';
import { SyncEngine, type SyncEvent } from '../sync/syncEngine';
import type { Clip } from '../tape/model';
import { finalizeFreeRecording, finalizeSyncRecording } from '../tape/recording';
import { drawPlayhead, drawWaveform } from './renderers/TimelineRenderer';

type Mode = 'free' | 'sync';
type TransportState = 'idle' | 'armed' | 'recording' | 'playing';

const CANVAS_WIDTH = 900;
const CANVAS_HEIGHT = 160;

export function TapePage() {
  const engineRef = useRef<AudioEngine | null>(null);
  const syncEngineRef = useRef<SyncEngine | null>(null);
  const poolRef = useRef(new AudioPool());
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('free');
  const [transport, setTransport] = useState<TransportState>('idle');
  const [clip, setClip] = useState<Clip | null>(null);
  const clipSamplesRef = useRef<Float32Array | null>(null);

  const [syncBpm, setSyncBpm] = useState(120);
  const [syncRunning, setSyncRunning] = useState(false);
  const [syncBeatPosition, setSyncBeatPosition] = useState(0);

  const [latency, setLatency] = useState<LatencyResult | null>(null);
  const [lastClipBeats, setLastClipBeats] = useState<number | null>(null);

  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedAudioDeviceId, setSelectedAudioDeviceId] = useState<string | null>(null);
  const [midiInputs, setMidiInputs] = useState<{ id: string; name: string | null }[]>([]);
  const [selectedMidiInputId, setSelectedMidiInputId] = useState<string | 'all'>('all');

  const playheadFrameRef = useRef(0);
  const playbackStartFrameRef = useRef(0);
  const armedForSyncRef = useRef(false);

  // Prefers a device/input whose label/name mentions "OP-Z" (e.g. Teenage
  // Engineering's OP-Z, our default hardware), falling back to the browser's
  // default (first-listed) device otherwise.
  const preferOpZ = <T,>(items: T[], getLabel: (item: T) => string | null): T | undefined =>
    items.find((item) => getLabel(item)?.toLowerCase().includes('op-z')) ?? items[0];

  const handleInit = useCallback(async () => {
    try {
      const engine = new AudioEngine();
      await engine.init();
      engineRef.current = engine;

      const devices = await engine.listInputDevices();
      setAudioDevices(devices);
      const defaultDevice = preferOpZ(devices, (d) => d.label);
      if (defaultDevice && defaultDevice.deviceId !== engine.inputDeviceId) {
        await engine.setInputDevice(defaultDevice.deviceId);
      }
      setSelectedAudioDeviceId(defaultDevice?.deviceId ?? engine.inputDeviceId ?? null);

      const syncEngine = new SyncEngine(engine.audioContext);
      await syncEngine.init();
      syncEngineRef.current = syncEngine;

      const inputs = syncEngine.listInputs();
      setMidiInputs(inputs);
      const defaultInput = preferOpZ(inputs, (i) => i.name);
      if (defaultInput) {
        syncEngine.setInputDevice(defaultInput.id);
        setSelectedMidiInputId(defaultInput.id);
      }

      syncEngine.on((event: SyncEvent) => {
        if (event.type === 'start') {
          setSyncRunning(true);
          if (armedForSyncRef.current) {
            armedForSyncRef.current = false;
            engine.startRecording();
            setTransport('recording');
          }
        } else if (event.type === 'stop') {
          setSyncRunning(false);
        } else if (event.type === 'clock') {
          setSyncBpm(event.bpm);
          setSyncBeatPosition(event.beatPosition);
        }
      });

      engine.onPlayhead((frame, playing) => {
        playheadFrameRef.current = frame;
        if (!playing) {
          setTransport((t) => (t === 'playing' ? 'idle' : t));
        }
      });

      setReady(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // Redraw loop: rendering never drives audio logic, only reads it.
  useEffect(() => {
    let raf = 0;
    const render = () => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (ctx && canvas) {
        const samples = clipSamplesRef.current ?? new Float32Array(0);
        drawWaveform(ctx, samples, CANVAS_WIDTH, CANVAS_HEIGHT);
        if (transport === 'playing' && samples.length > 0) {
          const framesIntoClip = playheadFrameRef.current - playbackStartFrameRef.current;
          const x = (framesIntoClip / samples.length) * CANVAS_WIDTH;
          if (x >= 0 && x <= CANVAS_WIDTH) drawPlayhead(ctx, x, CANVAS_HEIGHT);
        }
      }
      raf = requestAnimationFrame(render);
    };
    raf = requestAnimationFrame(render);
    return () => cancelAnimationFrame(raf);
  }, [transport]);

  const handleRecord = useCallback(() => {
    const engine = engineRef.current;
    if (!engine) return;
    if (mode === 'free') {
      engine.startRecording();
      setTransport('recording');
    } else {
      // Sync mode: arm now, actual capture begins on the next MIDI Start message.
      armedForSyncRef.current = true;
      setTransport('armed');
    }
  }, [mode]);

  const handleStop = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine) return;

    if (transport === 'playing') {
      engine.stopPlayback();
      setTransport('idle');
      return;
    }

    if (transport === 'armed') {
      armedForSyncRef.current = false;
      setTransport('idle');
      return;
    }

    if (transport === 'recording') {
      const recording = await engine.stopRecording();
      let newClip: Clip;
      if (mode === 'free') {
        newClip = finalizeFreeRecording(poolRef.current, recording.samples, 0);
        setLastClipBeats(null);
      } else {
        const syncEngine = syncEngineRef.current;
        const beatsElapsed = syncEngine?.beatPosition ?? 0;
        const samplesPerBeat = syncEngine?.samplesPerBeat() ?? engine.sampleRate;
        newClip = finalizeSyncRecording(poolRef.current, recording.samples, 0, beatsElapsed, samplesPerBeat);
        setLastClipBeats(beatsElapsed);
      }
      clipSamplesRef.current = poolRef.current.get(newClip.audioBufferId) ?? null;
      setClip(newClip);
      setTransport('idle');
    }
  }, [mode, transport]);

  const handlePlay = useCallback(() => {
    const engine = engineRef.current;
    if (!engine || !clip) return;
    const samples = clipSamplesRef.current ?? poolRef.current.get(clip.audioBufferId);
    if (!samples) return;
    const startFrame = engine.frameForTimeFromNow(0.05);
    playbackStartFrameRef.current = startFrame;
    engine.playClip(samples, startFrame);
    setTransport('playing');
  }, [clip]);

  const handleLatencyTest = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.startRecording();
    const clickAtFrame = engine.scheduleClick(0.05);
    await new Promise((resolve) => setTimeout(resolve, 700));
    const recording = await engine.stopRecording();
    setLatency(measureLatency(recording.samples, recording.startFrame, clickAtFrame, engine.sampleRate));
  }, []);

  const handleAudioDeviceChange = useCallback(async (deviceId: string) => {
    const engine = engineRef.current;
    if (!engine) return;
    await engine.setInputDevice(deviceId);
    setSelectedAudioDeviceId(deviceId);
  }, []);

  const handleMidiInputChange = useCallback((id: string) => {
    const syncEngine = syncEngineRef.current;
    if (!syncEngine) return;
    syncEngine.setInputDevice(id);
    setSelectedMidiInputId(id);
  }, []);

  const sampleRate = engineRef.current?.sampleRate ?? 44100;

  return (
    <div style={{ fontFamily: 'sans-serif', color: '#e4e4e7', background: '#09090b', minHeight: '100vh', padding: 24 }}>
      <h1>Tape — Stage 0 Spike</h1>
      {error && <p style={{ color: '#f87171' }}>Error: {error}</p>}

      {!ready ? (
        <button onClick={handleInit}>Enable Audio + MIDI</button>
      ) : (
        <>
          <div style={{ marginBottom: 12 }}>
            <label>
              Audio input:{' '}
              <select
                value={selectedAudioDeviceId ?? ''}
                onChange={(e) => handleAudioDeviceChange(e.target.value)}
                disabled={transport !== 'idle'}
              >
                {audioDevices.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || d.deviceId}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ marginLeft: 16 }}>
              MIDI input:{' '}
              <select
                value={selectedMidiInputId}
                onChange={(e) => handleMidiInputChange(e.target.value)}
                disabled={transport !== 'idle'}
              >
                <option value="all">All inputs</option>
                {midiInputs.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name || i.id}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div style={{ marginBottom: 12 }}>
            <label>
              <input type="radio" checked={mode === 'free'} onChange={() => setMode('free')} disabled={transport !== 'idle'} />
              {' '}Free
            </label>
            <label style={{ marginLeft: 12 }}>
              <input type="radio" checked={mode === 'sync'} onChange={() => setMode('sync')} disabled={transport !== 'idle'} />
              {' '}Sync
            </label>
          </div>

          <div style={{ marginBottom: 12 }}>
            <button onClick={handleRecord} disabled={transport !== 'idle'}>
              {mode === 'sync' ? 'Arm Record' : 'Record'}
            </button>
            <button onClick={handleStop} disabled={transport === 'idle'} style={{ marginLeft: 8 }}>
              Stop
            </button>
            <button onClick={handlePlay} disabled={transport !== 'idle' || !clip} style={{ marginLeft: 8 }}>
              Play
            </button>
            <button onClick={handleLatencyTest} disabled={transport !== 'idle'} style={{ marginLeft: 8 }}>
              Run Latency Test
            </button>
          </div>

          <canvas ref={canvasRef} width={CANVAS_WIDTH} height={CANVAS_HEIGHT} style={{ border: '1px solid #3f3f46' }} />

          <div style={{ marginTop: 12, fontSize: 14, lineHeight: 1.6 }}>
            <div>Transport: {transport}</div>
            <div>
              MIDI Clock: {syncRunning ? 'running' : 'stopped'} — {syncBpm.toFixed(1)} BPM — beat {syncBeatPosition.toFixed(2)}
            </div>
            {latency && (
              <div>
                Measured round-trip latency: {latency.latencyMs.toFixed(1)} ms (confidence {latency.confidence.toFixed(2)})
                {latency.confidence < 0.6 && (
                  <span style={{ color: '#f59e0b' }}>
                    {' '}— low confidence, click was not clearly detected. Try increasing output/input volume, reducing
                    background noise, or re-running the test.
                  </span>
                )}
              </div>
            )}
            {clip && (
              <div>
                Last clip: {clip.duration} samples ({(clip.duration / sampleRate).toFixed(3)}s)
                {lastClipBeats !== null && ` — recorded over ${lastClipBeats.toFixed(3)} beats`}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
