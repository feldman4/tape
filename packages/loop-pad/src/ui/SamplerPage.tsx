// Loop Pad — 16-slot MIDI sampler. See docs/manual.md for full behavior.
import { useEffect, useRef, useState } from 'react';
import { useSampler } from '../sampler/useSampler';
import { SLOT_COUNT } from '../sampler/model';
import { SlotView } from './SlotView';
import { SettingsPanel } from './SettingsPanel';
import { InputLevelMeter } from './InputLevelMeter';
import { btnStyle, selectStyle } from './btnStyle';

export function SamplerPage() {
  const s = useSampler();
  const [showSettings, setShowSettings] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // window.__loopPadTest hook — lets scripts/workflow-test.mjs simulate MIDI
  // note/CC/clock events without real MIDI or audio hardware (see its
  // comment header for why: Web MIDI needs no permission grant for non-sysex
  // access, but driving the sampler by MIDI keeps tests hardware-independent).
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__loopPadTest = {
      getState: () => ({
        ready: s.ready,
        error: s.error,
        projectIndex: s.projectIndex,
        settings: s.settings,
        bpm: s.bpm,
        clockRunning: s.clockRunning,
        countInCounting: s.countInCounting,
        slots: s.project.slots.map((slot, index) => ({
          index,
          state: slot.state,
          hasSample: slot.samples !== null,
          sampleChannels: slot.samples ? 2 : 0,
          durationSecs: slot.samples ? slot.samples.left.length / slot.sampleRate : 0,
          mixer: slot.mixer,
        })),
      }),
      noteOn: (note: number, velocity = 100, channel = s.settings.midiChannel) =>
        s.simulateMidiEvent({ type: 'noteon', note, velocity, channel }),
      noteOff: (note: number, channel = s.settings.midiChannel) =>
        s.simulateMidiEvent({ type: 'noteoff', note, channel }),
      cc: (controller: number, value: number, channel = s.settings.midiChannel) =>
        s.simulateMidiEvent({ type: 'cc', controller, value, channel }),
      clock: (timeStamp: number = performance.now()) => s.simulateMidiEvent({ type: 'clock', timeStamp }),
      start: () => s.simulateMidiEvent({ type: 'start' }),
      stop: () => s.simulateMidiEvent({ type: 'stop' }),
      startCountIn: () => s.startCountIn(),
      sentTransportEvents: () => s.getSentTransportEvents(),
      selectProject: (index: number) => s.selectProject(index),
      updateSettings: (patch: Partial<typeof s.settings>) => s.updateSettings(patch),
    };
  }, [s]);

  if (!s.ready) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', minHeight: '100vh' }}>
        {s.error && <p style={{ color: '#ef4444', maxWidth: 480 }}>{s.error}</p>}
        <button style={btnStyle} onClick={() => void s.init()}>Enable Audio + MIDI</button>
        {s.error && (
          <button
            style={{ ...btnStyle, color: '#fca5a5', borderColor: '#7f1d1d', marginTop: 12 }}
            onClick={() => {
              if (window.confirm('Clear all locally stored Loop Pad projects? This cannot be undone.')) {
                void s.clearProjectMemory().then(() => s.init());
              }
            }}
          >
            Clear Project Memory
          </button>
        )}
      </div>
    );
  }

  return (
    <>
      <InputLevelMeter analysers={s.inputLevelAnalysers} />
      <div style={{ padding: '16px 16px 16px 28px', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center' }}>
        <label style={{ fontSize: 13, color: '#a1a1aa', display: 'flex', gap: 6, alignItems: 'center' }}>
          Project
          <select style={selectStyle} value={s.projectIndex} onChange={(e) => void s.selectProject(Number(e.target.value))}>
            {Array.from({ length: s.projectCount }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>{String(n).padStart(2, '0')}</option>
            ))}
          </select>
        </label>
        <button style={btnStyle} onClick={() => void s.downloadProjects()}>Download</button>
        <button style={btnStyle} onClick={() => fileInputRef.current?.click()}>Restore</button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".zip,application/zip"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void s.restoreFromFile(file);
            e.target.value = '';
          }}
        />
        <span style={{ fontSize: 13, color: '#a1a1aa', display: 'flex', gap: 6, alignItems: 'center' }}>
          MIDI Clock
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: s.clockRunning ? '#22c55e' : '#3f3f46', display: 'inline-block' }} />
          {s.clockRunning ? (s.countInCounting ? 'Count-in' : 'Sync') : 'Idle'}
        </span>
        <span style={{ fontSize: 13, color: '#a1a1aa' }}>BPM {s.bpm ?? '?'}</span>
        <span style={{ fontSize: 13, color: s.settings.countInEnabled ? '#22c55e' : '#a1a1aa' }}>
          Count-in {s.settings.countInEnabled ? 'On' : 'Off'}
        </span>
        <button
          style={btnStyle}
          onClick={s.startCountIn}
          disabled={s.countInCounting || s.bpm === null}
          title={s.bpm === null ? 'Wait for MIDI Clock tempo' : 'Send Stop, count in, then send Start'}
        >
          Count-in
        </button>

        <button style={btnStyle} onClick={() => setShowSettings(true)} aria-label="Settings">⚙</button>
      </div>

      {s.restoreStatus && <div style={{ fontSize: 12, color: '#a1a1aa' }}>{s.restoreStatus}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, maxWidth: 640 }}>
        {Array.from({ length: SLOT_COUNT }, (_, i) => (
          <SlotView
            key={i}
            index={i}
            slot={s.project.slots[i]!}
            firstNote={s.settings.firstSampleNote}
            progress={s.playbackProgress[i] ?? null}
            tick={s.tick}
            active={s.project.slots[i]!.state !== 'empty'}
          />
        ))}
      </div>

      {showSettings && (
        <SettingsPanel
          settings={s.settings}
          onChange={s.updateSettings}
          audioInputs={s.audioInputs}
          selectedAudioInputId={s.selectedAudioInputId}
          onSelectAudioInput={(deviceId) => void s.selectAudioInput(deviceId)}
          audioInputChannelCount={s.audioInputChannelCount}
          selectedAudioInputChannelPairStart={s.selectedAudioInputChannelPairStart}
          onSelectAudioInputChannelPair={s.selectAudioInputChannelPair}
          audioOutputs={s.audioOutputs}
          selectedAudioOutputId={s.selectedAudioOutputId}
          onSelectAudioOutput={(deviceId) => void s.selectAudioOutput(deviceId)}
          audioOutputChannelCount={s.audioOutputChannelCount}
          selectedAudioOutputChannelPairStart={s.selectedAudioOutputChannelPairStart}
          onSelectAudioOutputChannelPair={s.selectAudioOutputChannelPair}
          midiInputs={s.midiInputs}
          selectedMidiInputId={s.selectedMidiInputId}
          onSelectMidiInput={s.selectMidiInput}
          midiOutputs={s.midiOutputs}
          selectedMidiOutputId={s.selectedMidiOutputId}
          onSelectMidiOutput={s.selectMidiOutput}
          onClearProjectMemory={() => {
            if (window.confirm('Clear all locally stored Loop Pad projects? This cannot be undone.')) {
              void s.clearProjectMemory();
            }
          }}
          onClose={() => setShowSettings(false)}
        />
      )}
      </div>
    </>
  );
}
