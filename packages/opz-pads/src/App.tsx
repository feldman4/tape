import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { MidiDevices } from './devices.ts';
import type { PortInfo } from './devices.ts';
import { Engine, newProject, validateProject } from './engine.ts';
import type { EditableSceneType } from './model.ts';
import { ControllerView, DiagnosticsView, DrumView, ScenesView } from './views.tsx';

type PortId = 'irig-in' | 'irig-out' | 'opz-in' | 'opz-out';
type Selection = Record<PortId, string>;
type Tab = 'controller' | 'scenes' | 'drum' | 'diagnostics';
const portIds: PortId[] = ['irig-in', 'irig-out', 'opz-in', 'opz-out'];
const tabs: { id: Tab; label: string }[] = [
  { id: 'controller', label: 'Controller' }, { id: 'scenes', label: 'Scenes' },
  { id: 'drum', label: 'Drum' }, { id: 'diagnostics', label: 'Diagnostics' },
];
const portLabels: Record<PortId, string> = {
  'irig-in': 'iRig input', 'irig-out': 'iRig output', 'opz-in': 'OP-Z input', 'opz-out': 'OP-Z output',
};
const emptySelection: Selection = { 'irig-in': '', 'irig-out': '', 'opz-in': '', 'opz-out': '' };
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

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
  const mountedRef = useRef(false);
  const requestingRef = useRef(false);

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
    const release = () => engine.releaseAll();
    window.addEventListener('pagehide', release);
    return () => {
      mountedRef.current = false;
      window.removeEventListener('pagehide', release);
      engine.releaseAll();
      devicesRef.current?.dispose();
      devicesRef.current = null;
    };
  }, [engine]);

  function configurePorts(devices: MidiDevices, selected: Selection): void {
    if (!devices.configureInputs(selected['irig-in'], selected['opz-in'],
      (data, time) => engine.irig(data, time), (data, time) => engine.opz(data, time))) {
      setMessage('Choose different iRig and OP-Z inputs.');
      return;
    }
    engine.refreshLeds();
    setConnection(selected['irig-in'] && selected['opz-in'] && selected['irig-out'] && selected['opz-out']
      ? '● MIDI CONNECTED' : '● MIDI SETUP');
  }

  function listPorts(devices: MidiDevices): void {
    if (devicesRef.current !== devices) return;
    const available = { input: devices.ports('input'), output: devices.ports('output') };
    const next = { ...selectionRef.current };
    let lostPort = false;
    for (const id of portIds) {
      const candidates = id.endsWith('-in') ? available.input : available.output;
      if (next[id] && !candidates.some((port) => port.id === next[id] && port.state === 'connected')) {
        next[id] = '';
        lostPort = true;
      }
    }
    selectionRef.current = next;
    setSelection(next);
    setPorts(available);
    if (lostPort) {
      engine.releaseAll();
      engine.transport = 'unknown';
      setMessage('A MIDI port disconnected. Select it again after reconnecting.');
    }
    configurePorts(devices, next);
    setRevision((revision) => revision + 1);
  }

  async function enableMidi(): Promise<void> {
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
    } catch (error) {
      if (mountedRef.current) setMessage(errorText(error));
    } finally {
      requestingRef.current = false;
    }
  }

  function changePort(id: PortId, value: string): void {
    engine.releaseAll();
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
        aria-current={tab === item.id ? 'page' : 'false'} onClick={() => setTab(item.id)}>{item.label}</button>)}
    </nav><span id="connection">{connection}</span></header>
    <section className="setup" hidden={tab !== 'controller'}><button id="enable" onClick={enableMidi}>{enabled ? 'MIDI enabled' : 'Enable MIDI'}</button>
      {portIds.map((id) => <label key={id}>{portLabels[id]} <select id={id} value={selection[id]}
        onChange={(event) => changePort(id, event.currentTarget.value)}>
        <option value="">None</option>
        {(id.endsWith('-in') ? ports.input : ports.output).filter((port) => port.state === 'connected')
          .map((port) => <option key={port.id} value={port.id}>{port.name || port.id}</option>)}
      </select></label>)}
    </section>
    <p id="message" role="status">{message}</p><main id="view">
      {tab === 'controller' ? <ControllerView engine={engine} />
        : tab === 'scenes' ? <ScenesView engine={engine} onTypeChange={changeSceneType} onImport={importProject}
          onExport={exportProject} onReset={() => { if (confirm('Replace the current project?')) engine.setProject(newProject()); }} />
          : tab === 'drum' ? <DrumView engine={engine} />
            : <DiagnosticsView engine={engine} selectedCell={selectedCell} onSelect={(ch, cc) => setSelectedCell([ch, cc])} />}
    </main>
    <footer>FIRST PASS · Mixer, performance FX and kit library are not implemented. See the manual for setup and limitations.</footer>
  </>;
}
