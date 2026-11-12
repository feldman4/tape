// Loop Pad — 16-slot MIDI sampler. See docs/manual.md for full behavior.
import { useEffect, useState } from 'react';
import { useSampler } from '../sampler/useSampler';
import { getSlotDisplayState } from '../sampler/model';
import { Keyboard } from './Keyboard';
import { SettingsPanel } from './SettingsPanel';
import { InputLevelMeter } from './InputLevelMeter';
import { SampleDisplay } from './SampleDisplay';
import { ProjectMenu } from './ProjectMenu';
import { btnStyle } from './btnStyle';

export function SamplerPage() {
  const s = useSampler();
  const [showSettings, setShowSettings] = useState(false);

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
        activeBank: s.activeBank,
        selectedSlot: s.selectedSlot?.slot ?? null,
        slots: s.project.banks[s.activeBank].map((slot, index) => ({
          index,
          state: getSlotDisplayState(slot),
          isPlaying: s.isSlotPlaying(index),
          hasSample: slot.sample !== null,
          sampleChannels: slot.sample ? (slot.sample.samples.mono ? 1 : 2) : 0,
          durationSecs: slot.sample ? slot.sample.samples.left.length / slot.sample.sampleRate : 0,
          playbackProgress: s.playbackProgress[index],
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
      sentTransportEvents: () => s.getSentTransportEvents(),
      selectProject: (index: number) => s.selectProject(index),
      initializeProject: () => s.initializeProject(),
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
      <div className="front-panel">
      <div className="panel-toolbar">
        <ProjectMenu
          projectIndex={s.projectIndex}
          projectCount={s.projectCount}
          onSelect={s.selectProject}
          onInitialize={s.initializeProject}
          onDownload={s.downloadProjects}
          onRestore={s.restoreFromFile}
        />
        <span className="toolbar-status clock-status">
          <span className={`clock-light ${s.clockRunning ? 'clock-running' : ''}`} />
          MIDI Clock {s.clockRunning ? (s.countInCounting ? 'Count-in' : 'Sync') : 'Idle'}
        </span>
        <span className="toolbar-status bpm-status">BPM&nbsp; {s.bpm ?? '?'}</span>
        <span className="toolbar-status count-in-status">
          Count-in {s.settings.countInEnabled ? 'On' : 'Off'}
        </span>
        <span className="toolbar-status mode-status">
          Mode {s.settings.recordingMode === 'take' ? 'Take' : 'One-shot'}
        </span>
        <button className="toolbar-button settings-button" onClick={() => setShowSettings(true)} aria-label="Settings">
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <path d="M4 6h16M4 12h16M4 18h16M8 3v6M16 9v6M10 15v6" />
          </svg>
        </button>
      </div>

      {s.restoreStatus && <div style={{ fontSize: 12, color: '#a1a1aa' }}>{s.restoreStatus}</div>}

      <div className="instrument-row">
        <InputLevelMeter analysers={s.inputLevelAnalysers} mono={s.selectedAudioInputChannel % 2 === 1} />
        <div className="instrument">
          {s.settings.channelMode && (
            <div className="bank-label">
              Bank {s.activeBank === 0 ? `A (MIDI ${s.settings.channelAMidiChannel + 1})` : `B (MIDI ${s.settings.channelBMidiChannel + 1})`}
            </div>
          )}
          <Keyboard
            slots={s.project.banks[s.activeBank]}
            settings={s.settings}
            progress={s.playbackProgress}
            tick={s.tick}
            selectedSlot={s.selectedSlot?.bank === s.activeBank ? s.selectedSlot.slot : null}
            flashingSlots={s.flashingSlots}
            bank={s.activeBank}
          />
        </div>
        <InputLevelMeter analysers={s.masterLevelAnalysers} side="right" level={s.settings.masterLevel} />
      </div>
      <SampleDisplay
        slot={s.selectedSlot?.bank === s.activeBank ? s.project.banks[s.activeBank][s.selectedSlot.slot]! : null}
        progress={s.selectedSlot?.bank === s.activeBank ? s.playbackProgress[s.selectedSlot.slot] ?? null : null}
        tick={s.tick}
        mixerEnabled={!s.settings.channelMode}
        bpm={s.bpm}
      />

      {showSettings && (
        <SettingsPanel
          settings={s.settings}
          onChange={s.updateSettings}
          audioInputs={s.audioInputs}
          selectedAudioInputId={s.selectedAudioInputId}
          onSelectAudioInput={(deviceId) => void s.selectAudioInput(deviceId)}
          audioInputChannelCount={s.audioInputChannelCount}
          selectedAudioInputChannel={s.selectedAudioInputChannel}
          onSelectAudioInputChannel={s.selectAudioInputChannel}
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
