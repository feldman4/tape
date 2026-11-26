import { Fragment } from 'react';
import type { ChangeEvent, CSSProperties } from 'react';
import type { Engine } from './engine.ts';
import type { EditableSceneType } from './model.ts';

type EngineProps = { engine: Engine };

function PadGrid({ engine, compact = false }: EngineProps & { compact?: boolean }) {
  const leds = engine.leds();
  return <div className={`pad-grid ${compact ? 'compact' : ''}`}>
    {Array.from({ length: 16 }, (_, order) => {
      const index = (3 - Math.floor(order / 4)) * 4 + order % 4;
      const [red, green] = leds[index];
      const style: CSSProperties & { '--red': number; '--green': number } = { '--red': red, '--green': green };
      return <div key={index} className={`pad ${red || green ? 'lit' : ''} ${engine.held[index] ? 'held' : ''}`}
        style={style} data-pad={index + 1}>
        <span>{String(index + 1).padStart(2, '0')}</span>{engine.held[index] && <b>▼</b>}
      </div>;
    })}
  </div>;
}

export function ControllerView({ engine }: EngineProps) {
  return <div className="controller">
    <div className="device-top"><div className="status-light">● <small>ON</small></div>
      <div className="small-control">SCENE</div><div className="small-control">FIX VEL</div>
      <div className={`small-control ${engine.buttons[0] ? 'active' : ''}`}>1</div>
      <div className={`small-control ${engine.buttons[1] ? 'active' : ''}`}>2</div>
      <strong>iRig <small>PADS</small></strong><div className={`encoder ${engine.push ? 'active' : ''}`}><span>DATA</span></div>
    </div><div className="device-body"><aside><div className="knob"><span>1</span></div><div className="knob"><span>2</span></div>
      <div className="fader"><i style={{ bottom: `${engine.fader / 127 * 100}%` }} /></div><small>SLIDER</small></aside>
      <PadGrid engine={engine} /></div>
  </div>;
}

type ScenesProps = EngineProps & {
  onTypeChange: (index: number, type: EditableSceneType) => void;
  onImport: (event: ChangeEvent<HTMLInputElement>) => void;
  onReset: () => void;
  onExport: () => void;
};

export function ScenesView({ engine, onTypeChange, onImport, onReset, onExport }: ScenesProps) {
  return <div className="scenes-layout"><aside><h2>CURRENT SCENE</h2>
    <div className="big">{String(engine.scene + 1).padStart(2, '0')}</div>
    <p className="accent">{engine.project.scenes[engine.scene].type.toUpperCase()}</p>
    <h2>PAD STATUS</h2><PadGrid engine={engine} compact /><p>SELECT SCENE ON iRIG</p></aside>
    <div className="scene-grid">{engine.project.scenes.map((item, index) =>
      <article key={index} className={`scene-card ${index === engine.scene ? 'selected' : ''}`}>
        <span>{String(index + 1).padStart(2, '0')}</span>
        <div className="scene-icon">{item.type === 'mixer' ? '▥' : item.type === 'drum' ? '∿' : '◇'}</div>
        <strong className={item.type}>{item.type.toUpperCase()}</strong>
        {index ? <label>Type <select data-scene-type={index} value={item.type} onChange={(event) => {
          const value = event.currentTarget.value;
          if (value === 'empty' || value === 'drum') onTypeChange(index, value);
        }}><option value="empty">Empty</option><option value="drum">Drum kit</option></select></label>
          : <small>FIXED MIXER</small>}
      </article>)}</div>
    <aside className="project"><h2>PROJECT</h2><p>16 SCENE SLOTS</p>
      <button id="export" onClick={onExport}>Download project</button>
      <label className="file-label">Load project<input type="file" id="import" accept=".json,application/json" onChange={onImport} /></label>
      <button id="reset" onClick={onReset}>New project</button>
      <p>Changes are saved in browser storage. Download backups regularly.</p></aside>
  </div>;
}

export function MixerView({ engine }: EngineProps) {
  const { mixer } = engine;
  return <div className="mixer-layout">
    <h2>TRACK LEVELS AND PAN</h2>
    <div className="mixer-tracks">{mixer.levels.map((level, index) =>
      <div className={`mixer-track track-color-${Math.floor(index / 4)}`} key={index}>
        <strong>{index + 1}</strong>
        <div className="mixer-level" aria-label={`Track ${index + 1} level ${level ?? 'unknown'}`}>
          {mixer.baseLevels[index] !== null && <i className="base-level" aria-label={`Track ${index + 1} underlying level ${mixer.baseLevels[index]}`}
            style={{ height: `${mixer.baseLevels[index] / 127 * 100}%` }} />}
          {level !== null && <i className="final-level" style={{ height: `${level / 127 * 100}%` }} />}
        </div>
        <span>{level ?? '—'}</span><small>PAN {mixer.pans[index] ?? '—'}</small>
        <small>{mixer.muted[index] === null ? 'UNKNOWN' : mixer.muted[index] ? 'MUTED' : 'ACTIVE'}</small>
      </div>)}</div>
    <div className="mixer-details"><section><h2>CONTROLLER STATUS</h2>
      <div className="mixer-buttons">{engine.buttons.map((pressed, index) =>
        <div key={index} data-button={index + 1} className={`mixer-button ${pressed ? 'active' : ''}`}
          role="img" aria-label={`Button ${index + 1}: ${pressed ? 'pressed' : 'released'}`}>
          <span>BUTTON {index + 1}</span><small>{pressed ? 'PRESSED' : 'RELEASED'}</small>
        </div>)}</div>
      <PadGrid engine={engine} compact /></section>
      <section><h2>MUTE GROUPS — {mixer.group + 1}</h2>
        <div className="mixer-matrix"><span />{mixer.muted.map((_, index) => <span key={index}>{index + 1}</span>)}
          {mixer.groups.map((group, groupIndex) => <Fragment key={groupIndex}>
            <span>{groupIndex + 1}</span>{group.map((muted, index) =>
              <span key={index} className={`track-color-${Math.floor(index / 4)}`}
                aria-label={`Group ${groupIndex + 1}, track ${index + 1}: ${muted === null ? 'unknown' : muted ? 'muted' : 'active'}`}>
                {muted === null ? '–' : muted ? '○' : '●'}
              </span>)}
          </Fragment>)}
        </div><p>● active &nbsp; ○ muted &nbsp; – unknown</p></section>
    </div>
  </div>;
}

export function DrumView({ engine }: EngineProps) {
  const current = engine.project.scenes[engine.scene];
  if (current.type !== 'drum') return <div className="empty-state"><h2>DRUM KIT</h2>
    <p>Configure a scene as a drum kit, then select it on the iRig.</p></div>;
  const names = ['KICK', 'SNARE', 'HI-HATS', 'SAMPLES'];
  return <div className="drum-layout"><div className="drum-grid">{current.pads.map((pad, index) => {
    const color = pad ? ['yellow', 'red', 'orange', 'green'][pad.channel] : 'unassigned';
    return <article key={index} className={`drum-card ${color}`}><span>{String(index + 1).padStart(2, '0')}</span>
      <b>{pad ? `T${pad.channel + 1}` : '—'}</b><h2>{pad ? names[pad.channel] : 'UNASSIGNED'}</h2>
      <p>{pad ? `MIDI NOTE ${pad.note}` : 'HOLD + PLAY OP-Z'}</p><small>MAX VEL {pad ? pad.velocity : '—'}</small>
      <div className="bar"><i style={{ width: `${pad ? pad.velocity / 127 * 100 : 0}%` }} /></div></article>;
  })}</div><aside className="mapping"><h2>PHYSICAL CONTROL MAPPING</h2>
    <table><thead><tr><th></th><th>POT 1</th><th>POT 2</th><th>DATA</th><th>PUSH + DATA</th><th>FADER</th></tr></thead>
      <tbody><tr><th>NONE</th><td>Pitch</td><td>HPF</td><td>LPF</td><td>LPF res</td><td>Max vel</td></tr>
        <tr><th>BUTTON 1</th><td>Start</td><td>Attack</td><td>Hold</td><td>Release</td><td>Compression</td></tr>
        <tr><th>BUTTON 2</th><td>FX 1</td><td>FX 2</td><td>Pan</td><td>Level</td><td>Compression</td></tr></tbody></table>
    <h2>NOTE ASSIGNMENT</h2><p>Stop the OP-Z, hold a pad and play a note on a drum track.</p>
    <p>TRANSPORT: <strong className="accent">{engine.transport.toUpperCase()}</strong></p>
    <p>Hold pads while moving controls to audition changes.</p></aside></div>;
}

export function DiagnosticsView({ engine, selectedCell, onSelect }: EngineProps & {
  selectedCell: [number, number];
  onSelect: (channel: number, controller: number) => void;
}) {
  const [ch, cc] = selectedCell;
  const now = Date.now();
  const history = engine.history[ch][cc].filter((entry) => now - entry.time <= 10000);
  const points = history.map((entry) => `${400 - (now - entry.time) * 400 / 10000},${127 - entry.before}`).join(' ');
  const last = history.at(-1);
  return <div className="diagnostics"><section><h2>CC VALUES</h2><p>16 × 16 (CHANNEL 1–16 × CC 1–16)</p>
    <div className="cc-grid"><span>CH / CC</span>{Array.from({ length: 16 }, (_, i) => <span key={i}>{i + 1}</span>)}
      {engine.values.map((row, channel) => <Fragment key={channel}><span>{channel + 1}</span>
        {row.map((value, controller) => <button key={controller} data-cell={`${channel},${controller}`}
          className={ch === channel && cc === controller ? 'selected' : ''}
          aria-label={`Channel ${channel + 1} CC ${controller + 1}`} onClick={() => onSelect(channel, controller)}>{value ?? '—'}</button>)}
      </Fragment>)}</div>
    <p><span className="accent">●</span> NO OFFSET &nbsp; <span className="purple">●</span> OFFSET (NOT IMPLEMENTED)</p></section>
    <section><h2>CC VALUE OVER TIME</h2><p>CHANNEL {ch + 1} / CC {cc + 1}</p>
      <svg className="graph" viewBox="0 0 400 127" preserveAspectRatio="none" aria-label="Recent CC values">
        <polyline points={points} />{last && <circle cx={400 - (now - last.time) * 400 / 10000} cy={127 - last.before} r="2" />}</svg>
      <p>{history.length} recent messages (last 10 seconds, up to 100)</p><h2>SELECTED CELL</h2>
      <p>CHANNEL {ch + 1} &nbsp; CC {cc + 1} &nbsp; VALUE {engine.values[ch][cc] ?? '—'}</p></section></div>;
}
