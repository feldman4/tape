import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { MidiDevices } from './devices.ts';
import type { PortInfo } from './devices.ts';
import { Engine, newProject, validateProject } from './engine.ts';
import { IrigCheck } from './IrigCheck.tsx';
import type { EditableSceneType } from './model.ts';
import { ControllerView, DiagnosticsView, DrumView, ScenesView } from './views.tsx';

type PortId = 'irig-in' | 'irig-out' | 'opz-in' | 'opz-out';
type Selection = Record<PortId, string>;
type Tab = 'controller' | 'scenes' | 'drum' | 'diagnostics' | 'irig-check';
const portIds: PortId[] = ['irig-in', 'irig-out', 'opz-in', 'opz-out'];
const tabs: { id: Tab; label: string }[] = [
  { id: 'controller', label: 'Controller' }, { id: 'scenes', label: 'Scenes' },
  { id: 'drum', label: 'Drum' }, { id: 'diagnostics', label: 'Diagnostics' },
  { id: 'irig-check', label: 'iRig check' },
];
const portLabels: Record<PortId, string> = {
  'irig-in': 'iRig input', 'irig-out': 'iRig output', 'opz-in': 'OP-Z input', 'opz-out': 'OP-Z output',
};
const emptySelection: Selection = { 'irig-in': '', 'irig-out': '', 'opz-in': '', 'opz-out': '' };
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
const isIrigPads = (port: PortInfo): boolean => /\birig\s*pads\b/i.test(port.name ?? '');

export default function App() {
  const [tab, setTab] = useState<Tab>('controller');
  const [selectedCell, setSelectedCell] = useState<[number, number]>([0, 0]);
  const [message, setMessage] = useState('');
  const [connection, setConnection] = useState('MIDI OFFLINE');
  const [selection, setSelection] = useState<Selection>(emptySelection);
  const [ports, setPorts] = useState<{ input: PortInfo[]; output: PortInfo[] }>({ input: [], output: [] });
  const [enabled, setEnabled] = useState(false);
  const [, setRevision] = useState(0);
  const selectionRef = useRef(selection);
  const devicesRef = useRef<MidiDevices | null>(null);
  const saveErrorRef = useRef('');
  const midiErrorRef = useRef('');
  const mountedRef = useRef(false);
  const requestingRef = useRef(false);
  const checkingRef = useRef(false);
  const checkInputRef = useRef<((bytes: Uint8Array) => void) | null>(null);
  const connectedPortsRef = useRef<{ input: Set<string>; output: Set<string> }>({ input: new Set(), output: new Set() });

  const [engine] = useState(() => new Engine({
    send(destination, bytes) {
      try {
        devicesRef.current?.send(selectionRef.current[`${destination}-out`], bytes);
      } catch (error) {
        setMessage(errorText(error));
      }
    },
    changed: () => setRevision((revision) => revision + 1),
    save(project) {
      try {
        localStorage.setItem('opz-pads-project-v1', JSON.stringify(project));
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
      (data, time) => { if (checkingRef.current) checkInputRef.current?.(data); else engine.irig(data, time); },
      (data, time) => { if (!checkingRef.current) engine.opz(data, time); })) {
      setMessage('Choose different iRig and OP-Z inputs.');
      return;
    }
    if (!checkingRef.current) engine.refreshLeds();
    setConnection(selected['irig-in'] && selected['opz-in'] && selected['irig-out'] && selected['opz-out']
      ? '● MIDI CONNECTED' : '● MIDI SETUP');
  }, [engine]);

  const listPorts = useCallback((devices: MidiDevices): void => {
    if (devicesRef.current !== devices) return;
    const available = { input: devices.ports('input'), output: devices.ports('output') };
    const next = { ...selectionRef.current };
    let lostPort = false;
    const lostIrig = { input: false, output: false };
    for (const id of portIds) {
      const candidates = id.endsWith('-in') ? available.input : available.output;
      if (next[id] && !candidates.some((port) => port.id === next[id] && port.state === 'connected')) {
        next[id] = '';
        lostPort = true;
        if (id === 'irig-in') lostIrig.input = true;
        if (id === 'irig-out') lostIrig.output = true;
      }
    }
    for (const direction of ['input', 'output'] as const) {
      const id = direction === 'input' ? 'irig-in' : 'irig-out';
      const connected = available[direction].filter((port) => port.state === 'connected');
      if (!next[id]) {
        const match = connected.find((port) => isIrigPads(port)
          && (lostIrig[direction] || !connectedPortsRef.current[direction].has(port.id))
          && (direction !== 'input' || port.id !== next['opz-in']));
        if (match) next[id] = match.id;
      }
      connectedPortsRef.current[direction] = new Set(connected.map((port) => port.id));
    }
    selectionRef.current = next;
    setSelection(next);
    setPorts(available);
    if (lostPort) {
      engine.releaseAll();
      engine.transport = 'unknown';
      setMessage('A MIDI port disconnected. iRig Pads reconnects automatically when available; reselect other ports as needed.');
    }
    configurePorts(devices, next);
    setRevision((revision) => revision + 1);
  }, [configurePorts, engine]);

  const enableMidi = useCallback(async (): Promise<void> => {
    if (requestingRef.current) return;
    requestingRef.current = true;
    try {
      if (!navigator.requestMIDIAccess) throw new Error('Web MIDI is unavailable. Use a supported Chromium browser over localhost or HTTPS.');
      const devices = new MidiDevices(await navigator.requestMIDIAccess());
      if (!mountedRef.current) return;
      if (devicesRef.current) {
        engine.releaseAll();
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
    mountedRef.current = true;
    try {
      const saved = localStorage.getItem('opz-pads-project-v1');
      if (saved) {
        const project: unknown = JSON.parse(saved);
        if (!validateProject(project)) throw new Error('Stored project has an invalid or unsupported format');
        engine.project = project;
        setRevision((revision) => revision + 1);
      }
    } catch (error) {
      setMessage(errorText(error));
    }
    const release = () => {
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
    engine.releaseAll();
    if (checkingRef.current && id === 'irig-out') engine.refreshLeds();
    if (id === 'opz-in') engine.transport = 'unknown';
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

  function changeTab(next: Tab): void {
    if (next === 'irig-check' && !checkingRef.current) {
      engine.releaseAll();
      engine.transport = 'unknown';
      checkingRef.current = true;
    } else if (next !== 'irig-check' && checkingRef.current) {
      checkingRef.current = false;
      engine.releaseAll();
      engine.refreshLeds();
      setMessage('Select a scene on the iRig and move a control or press a button to synchronize after the check.');
    }
    setTab(next);
  }

  const checkOutput = selection['irig-out'];
  const sendCheckMidi = useCallback((bytes: number[]): void => {
    if (!devicesRef.current?.send(checkOutput, bytes)) {
      throw new Error('The selected iRig output is not connected.');
    }
  }, [checkOutput]);
  const restoreCheckLeds = useCallback(() => engine.refreshLeds(), [engine]);

  async function importProject(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    try {
      const project: unknown = JSON.parse(await file.text());
      if (!validateProject(project)) throw new Error('Invalid or unsupported project file');
      if (confirm('Replace the current project?')) engine.setProject(project);
    } catch (error) {
      setMessage(errorText(error));
    }
    input.value = '';
  }

  function exportProject(): void {
    const url = URL.createObjectURL(new Blob([JSON.stringify(engine.project, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'opz-pads-project.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return <>
    <header><h1>OP-Z <span>PADS</span></h1><nav aria-label="Views">{tabs.map((item) =>
      <button key={item.id} data-tab={item.id} className={tab === item.id ? 'selected' : ''}
        aria-current={tab === item.id ? 'page' : 'false'} onClick={() => changeTab(item.id)}>{item.label}</button>)}
    </nav><span id="connection">{connection}</span></header>
    <section className="setup" hidden={tab !== 'controller' && tab !== 'irig-check'}><button id="enable" onClick={enableMidi}>{enabled ? 'MIDI enabled' : 'Enable MIDI'}</button>
      {portIds.map((id) => <label key={id}>{portLabels[id]} <select id={id} value={selection[id]}
        onChange={(event) => changePort(id, event.currentTarget.value)}>
        <option value="">None</option>
        {(id.endsWith('-in') ? ports.input : ports.output).filter((port) => port.state === 'connected')
          .map((port) => <option key={port.id} value={port.id}>{port.name || port.id}</option>)}
      </select></label>)}
    </section>
    <p id="message" role="status">{message}</p><main id="view">
      {tab === 'irig-check' ? <IrigCheck key={`${selection['irig-in']}:${selection['irig-out']}:${selection['opz-in']}`}
        ready={enabled && !!selection['irig-in'] && !!selection['irig-out'] && selection['irig-in'] !== selection['opz-in']}
        inputRef={checkInputRef} send={sendCheckMidi} restoreLeds={restoreCheckLeds} reportError={setMessage} />
        : tab === 'controller' ? <ControllerView engine={engine} />
        : tab === 'scenes' ? <ScenesView engine={engine} onTypeChange={changeSceneType} onImport={importProject}
          onExport={exportProject} onReset={() => { if (confirm('Replace the current project?')) engine.setProject(newProject()); }} />
          : tab === 'drum' ? <DrumView engine={engine} />
            : <DiagnosticsView engine={engine} selectedCell={selectedCell} onSelect={(ch, cc) => setSelectedCell([ch, cc])} />}
    </main>
    <footer>FIRST PASS · Mixer, performance FX and kit library are not implemented. See the manual for setup and limitations.</footer>
  </>;
}
