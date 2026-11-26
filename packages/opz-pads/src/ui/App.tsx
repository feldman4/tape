import { useCallback, useEffect, useRef, useState } from 'react';
import { ControllerState } from '../engine/controller.ts';
import { MidiDevices } from '../midi/devices.ts';
import type { PortInfo } from '../midi/devices.ts';
import { Engine } from '../engine/engine.ts';
import { IrigCheck } from './IrigCheck.tsx';
import { flipPadIndex, IRIG_MIDI } from '../irig/midi.ts';
import { decodeIrig } from '../midi/midi.ts';
import type { CustomSlot, EditableSceneType } from '../project/model.ts';
import { loadCustomSlots, loadProject, saveCustomSlots, saveProject } from '../project/storage.ts';
import { ControllerView, DiagnosticsView, DrumView, MixerView, PerformanceFxView, ScenesView } from './Views.tsx';

type PortId = 'irig-in' | 'irig-out' | 'opz-in' | 'opz-out' | 'iac-out';
type Selection = Record<PortId, string>;
type Tab = 'scene' | 'project' | 'opz' | 'irig-midi';
type LedLogEntry = { time: string; pad: number; color: string; value: number; sent: boolean };
const renderInterval = 50;
const portIds: PortId[] = ['irig-in', 'irig-out', 'opz-in', 'opz-out', 'iac-out'];
const tabs: { id: Tab; label: string }[] = [
  { id: 'scene', label: 'Scene' }, { id: 'project', label: 'Project' },
  { id: 'opz', label: 'OP-Z' }, { id: 'irig-midi', label: 'iRig MIDI' },
];
const portLabels: Record<PortId, string> = {
  'irig-in': 'iRig input', 'irig-out': 'iRig output', 'opz-in': 'OP-Z input', 'opz-out': 'OP-Z output',
  'iac-out': 'Ableton output',
};
const emptySelection: Selection = { 'irig-in': '', 'irig-out': '', 'opz-in': '', 'opz-out': '', 'iac-out': '' };
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
const isIrigPads = (port: PortInfo): boolean => /\birig\s*pads\b/i.test(port.name ?? '');
const isOpz = (port: PortInfo): boolean => /\bop-z\b/i.test(port.name ?? '');
const isIac = (port: PortInfo): boolean => /\biac driver bus 1\b/i.test(port.name ?? '');

export default function App() {
  const [tab, setTab] = useState<Tab>('scene');
  const [selectedCell, setSelectedCell] = useState<[number, number]>([0, 0]);
  const [message, setMessage] = useState('');
  const [connection, setConnection] = useState('MIDI OFFLINE');
  const [ledLog, setLedLog] = useState<LedLogEntry[]>([]);
  const [showLedLog, setShowLedLog] = useState(false);
  const [selection, setSelection] = useState<Selection>(emptySelection);
  const [ports, setPorts] = useState<{ input: PortInfo[]; output: PortInfo[] }>({ input: [], output: [] });
  const [enabled, setEnabled] = useState(false);
  const [, setRevision] = useState(0);
  const selectionRef = useRef(selection);
  const navRef = useRef<HTMLElement | null>(null);
  const devicesRef = useRef<MidiDevices | null>(null);
  const saveErrorRef = useRef('');
  const midiErrorRef = useRef('');
  const mountedRef = useRef(false);
  const requestingRef = useRef(false);
  const checkingRef = useRef(false);
  const [checkController] = useState(() => new ControllerState());
  const checkInputRef = useRef<((bytes: Uint8Array) => void) | null>(null);
  const connectedPortsRef = useRef<{ input: Set<string>; output: Set<string> }>({ input: new Set(), output: new Set() });

  // Render immediately, then at most once per renderInterval while MIDI traffic is dense.
  const renderState = useRef<{ last: number; timer: ReturnType<typeof setTimeout> | undefined }>({ last: 0, timer: undefined });
  const requestRender = useCallback((): void => {
    const state = renderState.current;
    if (state.timer !== undefined) return;
    const wait = state.last + renderInterval - performance.now();
    const render = () => {
      state.timer = undefined;
      state.last = performance.now();
      setRevision((revision) => revision + 1);
    };
    if (wait <= 0) render();
    else state.timer = setTimeout(render, wait);
  }, []);
  useEffect(() => () => {
    clearTimeout(renderState.current.timer);
    renderState.current.timer = undefined;
  }, []);
  const selectCell = useCallback((channel: number, controller: number) => setSelectedCell([channel, controller]), []);

  const logPadLed = useCallback((bytes: number[], sent: boolean): void => {
    if (bytes.length !== 3 || bytes[0] !== 0xb0 + IRIG_MIDI.ledChannel) return;
    const pad = IRIG_MIDI.padGreenLedCCs.findIndex((cc) => bytes[1] === cc || bytes[1] === cc + 1);
    if (pad < 0) return;
    const entry: LedLogEntry = {
      time: new Date().toLocaleTimeString('en-GB', { hour12: false, fractionalSecondDigits: 3 }),
      pad: flipPadIndex(pad) + 1, color: bytes[1] === IRIG_MIDI.padGreenLedCCs[pad] ? 'green' : 'red', value: bytes[2], sent,
    };
    setLedLog((previous) => [...previous.slice(-99), entry]);
  }, []);

  const [engine] = useState(() => new Engine({
    send(destination, bytes) {
      try {
        const devices = devicesRef.current;
        const sent = devices?.send(selectionRef.current[`${destination}-out`], bytes) ?? false;
        if (destination === 'irig') logPadLed(bytes, sent);
        if (devices && !sent && destination !== 'irig') {
          setMessage(`The ${destination === 'iac' ? 'Ableton' : 'OP-Z'} MIDI output is not connected.`);
        }
        return sent;
      } catch (error) {
        if (destination === 'irig') logPadLed(bytes, false);
        setMessage(errorText(error));
        return false;
      }
    },
    changed: () => requestRender(),
    notify: setMessage,
    save(project) {
      try {
        saveProject(project);
        const previousError = saveErrorRef.current;
        if (previousError) setMessage((current) => current === previousError ? '' : current);
        saveErrorRef.current = '';
      } catch (error) {
        const text = `Could not save project: ${errorText(error)}`;
        saveErrorRef.current = text;
        setMessage(text);
      }
    },
  }));

  const configurePorts = useCallback((devices: MidiDevices, selected: Selection): void => {
    if (!devices.configureInputs(selected['irig-in'], selected['opz-in'],
      (data, time) => {
        if (checkingRef.current) {
          const event = decodeIrig(data);
          if (event) {
            switch (event.type) {
              case 'pad':
                checkController.held[event.index] = event.on;
                checkController.pressure[event.index] = event.on ? event.velocity : 0;
                break;
              case 'pressure':
                if (checkController.held[event.index]) checkController.pressure[event.index] = event.value;
                break;
              case 'button': checkController.button(event.index, event.pressed); break;
              case 'push': checkController.push = event.pressed; break;
              case 'control': checkController.move(event.control, event.value); break;
            }
            setRevision((revision) => revision + 1);
          }
          checkInputRef.current?.(data);
        } else engine.irig(data, time);
      },
      (data, time) => {
        if (!checkingRef.current) engine.opz(data, time);
        else {
          try {
            if (!devices.send(selectionRef.current['iac-out'], Array.from(data))) setMessage('The Ableton MIDI output is not connected.');
          } catch (error) {
            setMessage(errorText(error));
          }
        }
      })) {
      setMessage('Choose different iRig and OP-Z inputs.');
      return;
    }
    if (!checkingRef.current) engine.refreshLeds();
    setConnection(selected['irig-in'] && selected['opz-in'] && selected['irig-out'] && selected['opz-out'] && selected['iac-out']
      ? '● MIDI CONNECTED' : '● MIDI SETUP');
  }, [checkController, engine]);

  const listPorts = useCallback((devices: MidiDevices): void => {
    if (devicesRef.current !== devices) return;
    const available = { input: devices.ports('input'), output: devices.ports('output') };
    const next = { ...selectionRef.current };
    let lostPort = false;
    const lostSelections = new Set<PortId>();
    for (const id of portIds) {
      const candidates = id.endsWith('-in') ? available.input : available.output;
      if (next[id] && !candidates.some((port) => port.id === next[id] && port.state === 'connected')) {
        next[id] = '';
        lostPort = true;
        lostSelections.add(id);
      }
    }
    for (const direction of ['input', 'output'] as const) {
      const connected = available[direction].filter((port) => port.state === 'connected');
      for (const device of ['irig', 'opz'] as const) {
        const id: PortId = `${device}-${direction === 'input' ? 'in' : 'out'}`;
        const otherInput = device === 'irig' ? 'opz-in' : 'irig-in';
        const matchesDevice = device === 'irig' ? isIrigPads : isOpz;
        if (!next[id]) {
          const match = connected.find((port) => matchesDevice(port)
            && (lostSelections.has(id) || !connectedPortsRef.current[direction].has(port.id))
            && (direction !== 'input' || port.id !== next[otherInput]));
          if (match) next[id] = match.id;
        }
        if (direction === 'output' && !next['iac-out']) {
          const match = connected.find((port) => isIac(port)
            && (lostSelections.has('iac-out') || !connectedPortsRef.current.output.has(port.id))
            && port.id !== next['opz-out'] && port.id !== next['irig-out']);
          if (match) next['iac-out'] = match.id;
        }
      }
      connectedPortsRef.current[direction] = new Set(connected.map((port) => port.id));
    }
    selectionRef.current = next;
    setSelection(next);
    setPorts(available);
    if (lostPort) {
      engine.portDisconnected(lostSelections.has('opz-in'));
      checkController.release();
    }
    configurePorts(devices, next);
    setRevision((revision) => revision + 1);
  }, [checkController, configurePorts, engine]);

  const enableMidi = useCallback(async (): Promise<void> => {
    if (requestingRef.current) return;
    requestingRef.current = true;
    try {
      if (!navigator.requestMIDIAccess) throw new Error('Web MIDI is unavailable. Use a supported Chromium browser over localhost or HTTPS.');
      const devices = new MidiDevices(await navigator.requestMIDIAccess());
      if (!mountedRef.current) return;
      if (devicesRef.current) {
        engine.releaseAll();
        engine.resetOpz();
        devicesRef.current.dispose();
      }
      devicesRef.current = devices;
      devices.onStateChange(() => listPorts(devices));
      listPorts(devices);
      setEnabled(true);
      const previousError = midiErrorRef.current;
      if (previousError) setMessage((current) => current === previousError ? '' : current);
      midiErrorRef.current = '';
    } catch (error) {
      if (mountedRef.current) {
        midiErrorRef.current = errorText(error);
        setMessage(midiErrorRef.current);
      }
    } finally {
      requestingRef.current = false;
    }
  }, [engine, listPorts]);

  useEffect(() => {
    const toggleLedLog = (event: KeyboardEvent) => {
      if (tab === 'scene' || tab === 'project' || (event.key !== '`' && event.key !== '~') || event.repeat || event.ctrlKey || event.metaKey || event.altKey
        || (event.target instanceof HTMLElement && (event.target.isContentEditable
          || ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)))) return;
      setShowLedLog((visible) => !visible);
    };
    window.addEventListener('keydown', toggleLedLog);
    return () => window.removeEventListener('keydown', toggleLedLog);
  }, [tab]);

  useEffect(() => {
    mountedRef.current = true;
    try {
      const project = loadProject();
      if (project) engine.restoreProject(project);
      const slots = loadCustomSlots();
      if (slots) engine.setCustomSlots(slots);
    } catch (error) {
      setMessage(errorText(error));
    }
    const release = () => {
      engine.cancelReleaseLedRefreshes();
      engine.releaseAll();
      if (checkingRef.current) engine.refreshLeds();
    };
    window.addEventListener('pagehide', release);
    void enableMidi();
    return () => {
      mountedRef.current = false;
      window.removeEventListener('pagehide', release);
      release();
      devicesRef.current?.dispose();
      devicesRef.current = null;
    };
  }, [enableMidi, engine]);

  function changePort(id: PortId, value: string): void {
    if (value && ((id === 'iac-out' && (value === selectionRef.current['opz-out'] || value === selectionRef.current['irig-out']))
      || ((id === 'opz-out' || id === 'irig-out') && value === selectionRef.current['iac-out']))) {
      setMessage('Choose a separate Ableton output to avoid MIDI feedback.');
      return;
    }
    engine.releaseAll();
    checkController.release();
    if (checkingRef.current && id === 'irig-out') engine.refreshLeds();
    if (id === 'opz-in' && value !== selectionRef.current['opz-in']) engine.resetOpz();
    const next = { ...selectionRef.current, [id]: value };
    selectionRef.current = next;
    setSelection(next);
    if (devicesRef.current) configurePorts(devicesRef.current, next);
    setRevision((revision) => revision + 1);
  }

  function changeSceneType(index: number, type: EditableSceneType): void {
    if (engine.project.scenes[index].type !== 'empty' && !confirm('Replace this scene and its assignments?')) return;
    engine.setType(index, type);
  }

  function changeCustomSlots(slots: CustomSlot[]): void {
    saveCustomSlots(slots);
    engine.setCustomSlots(slots);
  }

  const changeTab = useCallback((next: Tab): void => {
    if (next === 'irig-midi' && !checkingRef.current) {
      engine.enterCheckMode(checkController);
      checkingRef.current = true;
    } else if (next !== 'irig-midi' && checkingRef.current) {
      checkingRef.current = false;
      engine.exitCheckMode(checkController);
      setMessage('Select a scene on the iRig and move the fader to synchronize after the check.');
    }
    setTab(next);
  }, [checkController, engine]);

  useEffect(() => {
    const switchView = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.repeat ||
        (event.target instanceof HTMLElement && (event.target.isContentEditable ||
          ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)))) return;
      const index = ['1', '2', '3', '4'].indexOf(event.key);
      if (index >= 0) {
        const next = tabs[index].id;
        if (event.target instanceof HTMLElement && navRef.current?.contains(event.target)) {
          navRef.current.querySelector<HTMLButtonElement>(`button[data-tab="${next}"]`)?.focus();
        }
        changeTab(next);
      }
    };
    window.addEventListener('keydown', switchView);
    return () => window.removeEventListener('keydown', switchView);
  }, [changeTab]);

  const checkOutput = selection['irig-out'];
  const sendCheckMidi = useCallback((bytes: number[]): void => {
    let sent: boolean;
    try {
      sent = devicesRef.current?.send(checkOutput, bytes) ?? false;
    } catch (error) {
      logPadLed(bytes, false);
      throw error;
    }
    logPadLed(bytes, sent);
    if (!sent) {
      throw new Error('The selected iRig output is not connected.');
    }
  }, [checkOutput, logPadLed]);
  const restoreCheckLeds = useCallback(() => engine.refreshLeds(), [engine]);

  return <>
    <header><h1>OP-Z <span>PADS</span></h1><nav ref={navRef} aria-label="Views">{tabs.map((item) =>
      <button key={item.id} data-tab={item.id} className={tab === item.id ? 'selected' : ''}
        aria-current={tab === item.id ? 'page' : 'false'} onClick={() => changeTab(item.id)}>{item.label}</button>)}
    </nav><span id="connection" hidden={tab !== 'irig-midi'}>{connection}</span></header>
    <section className="setup" hidden={tab !== 'irig-midi'}><button id="enable" onClick={enableMidi}>{enabled ? 'MIDI enabled' : 'Enable MIDI'}</button>
      {portIds.map((id) => <label key={id}>{portLabels[id]} <select id={id} value={selection[id]}
        onChange={(event) => changePort(id, event.currentTarget.value)}>
        <option value="">None</option>
        {(id.endsWith('-in') ? ports.input : ports.output).filter((port) => port.state === 'connected')
          .map((port) => <option key={port.id} value={port.id}>{port.name || port.id}</option>)}
      </select></label>)}
    </section>
    <p id="message" role="status">{message}</p><main id="view">
      {tab === 'irig-midi' ? <div className="irig-layout">
        <div><ControllerView engine={engine} controller={checkController} />
          <p className="irig-led-note">Pad colors show the last scene state, not LED test or color explorer output.</p></div>
        <IrigCheck key={`${selection['irig-in']}:${selection['irig-out']}:${selection['opz-in']}`}
          ready={enabled && !!selection['irig-in'] && !!selection['irig-out'] && selection['irig-in'] !== selection['opz-in']}
          inputRef={checkInputRef} send={sendCheckMidi} restoreLeds={restoreCheckLeds} reportError={setMessage} /></div>
        : tab === 'project' ? <ScenesView engine={engine} onTypeChange={changeSceneType} reportError={setMessage} />
          : tab === 'scene' ? engine.project.scenes[engine.scene].type === 'mixer' ? <MixerView engine={engine} />
            : engine.project.scenes[engine.scene].type === 'drum' ? <DrumView engine={engine} />
              : engine.project.scenes[engine.scene].type === 'fx' ? <PerformanceFxView engine={engine} onSaveSlots={changeCustomSlots} reportError={setMessage} />
              : <div className="empty-state"><h2>EMPTY SCENE</h2><p>Configure this scene in Project.</p></div>
            : <DiagnosticsView engine={engine} selectedCell={selectedCell} onSelect={selectCell} />}
    </main>
    <footer className={showLedLog && tab !== 'scene' && tab !== 'project' ? 'with-led-log' : ''}>See the manual for setup and limitations.</footer>
    <aside className="led-log" aria-label="Pad LED output log" hidden={!showLedLog || tab === 'scene' || tab === 'project'}>
      <strong>PAD LED OUTPUT · LAST 100 MESSAGES</strong>
      <div role="log" aria-live="off">{ledLog.length === 0 ? 'No pad LED messages yet.' : [...ledLog].reverse().map((entry, index) =>
        <div key={ledLog.length - index}>{entry.time} · PAD {entry.pad} · {entry.color.toUpperCase()} {entry.value} · {entry.sent ? 'SENT' : 'FAILED'}</div>)}</div>
    </aside>
  </>;
}
