import { Fragment, memo, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { ControllerState } from '../engine/controller.ts';
import type { Engine } from '../engine/engine.ts';
import type { CustomSlot, DrumChannel, EditableSceneType } from '../project/model.ts';
import { validateCustomSlots } from '../project/model.ts';
import { kitDragType, LibraryView } from './Library.tsx';

type EngineProps = { engine: Engine };

function PadGrid({ engine, compact = false, held = engine.held }: EngineProps & { compact?: boolean; held?: boolean[] }) {
  const leds = engine.leds();
  return <div className={`pad-grid ${compact ? 'compact' : ''}`}>
    {Array.from({ length: 16 }, (_, index) => {
      const [red, green] = leds[index];
      const style: CSSProperties & { '--red': number; '--green': number } = { '--red': red, '--green': green };
      return <div key={index} className={`pad ${red || green ? 'lit' : ''} ${held[index] ? 'held' : ''}`}
        style={style} data-pad={index + 1}>
        <span>{String(index + 1).padStart(2, '0')}</span>{held[index] && <b>▼</b>}
      </div>;
    })}
  </div>;
}

function ControllerControls({ fader, pots, crossfade }: {
  fader: number;
  pots: readonly [number | null, number | null];
  crossfade?: { a: number | null; b: number | null };
}) {
  const slider = <div className="fader"><i style={{ bottom: `${fader / 127 * 100}%` }} /></div>;
  return <aside className="controller-controls">
    {pots.map((value, index) => <div key={index} className="knob" role="img"
      aria-label={`Pot ${index + 1} position ${value ?? 'unknown'}`}>
      {value !== null && <i style={{ transform: `rotate(${-135 + value / 127 * 270}deg)` }} />}
      <span>{index + 1}</span>
    </div>)}
    {crossfade ? <div className="fx-crossfader" role="img"
      aria-label={`Crossfader ${fader} of 127; A ${crossfade.a === null ? 'unassigned' : `pad ${crossfade.a + 1}`}; B ${crossfade.b === null ? 'unassigned' : `pad ${crossfade.b + 1}`}`}>
      <div className="fx-crossfader-end"><strong>B</strong><small>{crossfade.b === null ? '—' : `PAD ${crossfade.b + 1}`}</small></div>
      {slider}
      <div className="fx-crossfader-end"><strong>A</strong><small>{crossfade.a === null ? '—' : `PAD ${crossfade.a + 1}`}</small></div>
    </div> : <>{slider}<small>SLIDER</small></>}
  </aside>;
}

export function ControllerView({ engine, controller }: EngineProps & { controller: ControllerState }) {
  return <div className="controller">
    <div className="device-top"><div className="status-light">● <small>ON</small></div>
      <div className="small-control">SCENE</div><div className="small-control">FIX VEL</div>
      <div className={`small-control ${controller.buttons[0] ? 'active' : ''}`}>1</div>
      <div className={`small-control ${controller.buttons[1] ? 'active' : ''}`}>2</div>
      <strong>iRig <small>PADS</small></strong><div className={`encoder ${controller.push ? 'active' : ''}`}><span>DATA</span></div>
    </div><div className="device-body"><ControllerControls fader={controller.fader} pots={controller.pots} />
      <PadGrid engine={engine} held={controller.held} /></div>
  </div>;
}

type ScenesProps = EngineProps & {
  onTypeChange: (index: number, type: EditableSceneType) => void;
  reportError: (message: string) => void;
};

export function ScenesView({ engine, onTypeChange, reportError }: ScenesProps) {
  return <div className="scenes-layout"><aside><h2>CURRENT SCENE</h2>
    <div className="big">{String(engine.scene + 1).padStart(2, '0')}</div>
    <p className="accent">{engine.project.scenes[engine.scene].type.toUpperCase()}</p>
    <h2>PAD STATUS</h2><PadGrid engine={engine} compact /><p>SELECT SCENE ON iRIG</p></aside>
    <div className="scene-grid">{engine.project.scenes.map((item, index) =>
      <article key={index} className={`scene-card ${index === engine.scene ? 'selected' : ''}`}
        onDragOver={(event) => {
          if (index && Array.from(event.dataTransfer.types).includes(kitDragType)) {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
          }
        }}
        onDrop={(event) => {
          if (!index || !Array.from(event.dataTransfer.types).includes(kitDragType)) return;
          event.preventDefault();
          try {
            const kit: unknown = JSON.parse(event.dataTransfer.getData(kitDragType));
            engine.setKit(index, kit);
          } catch (error) {
            reportError(`Could not load kit: ${error instanceof Error ? error.message : String(error)}`);
          }
        }}>
        <span>{String(index + 1).padStart(2, '0')}</span>
        <div className="scene-icon">{item.type === 'mixer' ? '▥' : item.type === 'drum' ? '∿' : item.type === 'fx' ? '✦' : '◇'}</div>
        <strong className={item.type}>{item.type.toUpperCase()}</strong>
        {index ? <label>Type <select data-scene-type={index} value={item.type} onChange={(event) => {
          const value = event.currentTarget.value;
          if (value === 'empty' || value === 'drum' || value === 'fx') onTypeChange(index, value);
        }}><option value="empty">Empty</option><option value="drum">Drum kit</option><option value="fx">Performance FX</option></select></label>
          : <small>FIXED MIXER</small>}
      </article>)}</div>
    <LibraryView engine={engine} reportError={reportError} />
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
  const names: Record<DrumChannel, string> = { 0: 'KICK', 1: 'SNARE', 2: 'HI-HATS', 3: 'SAMPLES', 12: 'PERF FX' };
  const colors: Record<DrumChannel, string> = { 0: 'yellow', 1: 'red', 2: 'orange', 3: 'green', 12: 'green' };
  return <div className="drum-layout"><div className="drum-grid">{current.pads.map((pad, index) => {
    const color = pad ? colors[pad.channel] : 'unassigned';
    const velocity = engine.drumVelocities[index];
    return <article key={index} className={`drum-card ${color}`}><span>{String(index + 1).padStart(2, '0')}</span>
      {engine.drumFlashes[index] !== 0 && <span key={engine.drumFlashes[index]} className="drum-flash" aria-hidden="true" />}
      <b>{pad ? `T${pad.channel + 1}` : '—'}</b><h2>{pad ? names[pad.channel] : 'UNASSIGNED'}</h2>
      <p>{pad ? `MIDI NOTE ${pad.note}` : 'HOLD + PLAY OP-Z'}</p><small>MAX VEL {pad ? pad.velocity : '—'}</small>
      <div className="bar" role="img" aria-label={`Pad ${index + 1} maximum velocity ${pad?.velocity ?? 'unknown'}${velocity === null ? '' : `, played velocity ${velocity}`}`}>
        <i className="base-velocity" style={{ width: `${pad ? pad.velocity / 127 * 100 : 0}%` }} />
        {velocity !== null && <i className="played-velocity" style={{ width: `${velocity / 127 * 100}%` }} />}
      </div></article>;
  })}</div><aside className="mapping"><h2>PHYSICAL CONTROL MAPPING</h2>
    <table><thead><tr><th></th><th>POT 1</th><th>POT 2</th><th>DATA</th><th>PUSH + DATA</th><th>FADER</th></tr></thead>
      <tbody><tr><th>NONE</th><td>Pitch</td><td>HPF</td><td>LPF</td><td>LPF res</td><td>Max vel</td></tr>
        <tr><th>BUTTON 1</th><td>Start</td><td>Attack</td><td>Hold</td><td>Release</td><td>Compression</td></tr>
        <tr><th>BUTTON 2</th><td>FX 1</td><td>FX 2</td><td>Pan</td><td>Level</td><td>Compression</td></tr></tbody></table>
    <h2>NOTE ASSIGNMENT</h2><p>Stop the OP-Z, hold a pad and play a note on a drum or performance FX track.</p>
    <p>TRANSPORT: <strong className="accent">{engine.transport.toUpperCase()}</strong></p>
    <p>Hold pads while moving controls to audition changes.</p></aside></div>;
}

export function PerformanceFxView({ engine, onSaveSlots, reportError }: EngineProps & {
  onSaveSlots: (slots: CustomSlot[]) => void;
  reportError: (message: string) => void;
}) {
  const [slotIndex, setSlotIndex] = useState(0);
  const scene = engine.project.scenes[engine.scene];
  if (scene.type !== 'fx') return null;
  const slot = engine.customSlots[slotIndex];
  const depths = engine.fxDepths;
  return <div className="drum-layout"><div className="fx-pad-layout">
    <ControllerControls fader={engine.fader} pots={engine.pots} crossfade={{ a: scene.a, b: scene.b }} />
    <div className="drum-grid">{scene.pads.map((pad, index) =>
    <article key={index} className={`drum-card fx-card ${pad?.type === 'scene' ? 'orange' : pad?.type === 'custom' ? 'red' : pad?.type === 'note' ? 'green' : ''}`}>
      <div className="fx-card-head"><span>{String(index + 1).padStart(2, '0')}</span><b>{scene.a === index ? 'A ' : ''}{scene.b === index ? 'B' : ''}</b></div>
      <h2>{pad?.type.toUpperCase() ?? 'UNASSIGNED'}</h2>
      <p>{pad?.type === 'note' ? `CH ${pad.channel + 1} · NOTE ${pad.note}` :
        pad?.type === 'custom' ? `SLOT ${pad.slot + 1}` : pad?.type === 'scene' ?
          pad.offsets.map((offset) => `CH ${offset.channel + 1} CC ${offset.cc}: ${offset.offset >= 0 ? '+' : ''}${offset.offset}`).join(', ') || 'NO OFFSETS' :
          'HOLD + ASSIGN'}</p>
      {(pad?.type === 'scene' || pad?.type === 'custom') && <div className="fx-depth">
        <small>{pad.type === 'scene' ? 'DEPTH' : 'PRESSURE'} {Math.round(depths[index] * 100)}%</small>
        <div className="bar" role="img" aria-label={`Pad ${index + 1} ${pad.type === 'scene' ? 'depth' : 'pressure'} ${Math.round(depths[index] * 100)}%`}>
          <i style={{ width: `${depths[index] * 100}%` }} />
        </div>
      </div>}
    </article>)}</div></div>
    <aside className="mapping"><h2>PERFORMANCE FX</h2>
      <p>Hold a pad and reverse an OP-Z parameter to add an offset. Turn DATA; click to finish. Reverse the same parameter again while holding the pad to remove it. Hold + turn pot 2 at least 15 CC steps left for A or right for B; turn without a pad to clear that side.</p>
      <p>Hold + push-turn DATA selects a custom slot. Effects are sent to Ableton only.</p>
      <p>TRANSPORT: <strong className="accent">{engine.transport.toUpperCase()}</strong></p>
      <h2>CUSTOM SLOTS</h2>
      <label>Slot <select aria-label="Custom slot" value={slotIndex} onChange={(event) => setSlotIndex(Number(event.currentTarget.value))}>
        {engine.customSlots.map((_, index) => <option value={index} key={index}>{index + 1}</option>)}</select></label>
      <form key={slotIndex} className="fx-slot-form" onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const number = (name: string) => Number(data.get(name));
        const slots = structuredClone(engine.customSlots);
        slots[slotIndex] = { channel: number('channel') - 1, cc: number('cc'), min: number('min'), max: number('max') };
        try {
          if (!event.currentTarget.checkValidity() || !validateCustomSlots(slots)) throw new Error('Enter valid MIDI values.');
          onSaveSlots(slots);
          reportError('');
        } catch (error) {
          reportError(`Could not save custom slots: ${error instanceof Error ? error.message : String(error)}`);
        }
      }}>
        <label>Channel <input name="channel" type="number" min="1" max="16" required defaultValue={slot.channel + 1} /></label>
        <label>CC <input name="cc" type="number" min="0" max="127" required defaultValue={slot.cc} /></label>
        <label>Minimum <input name="min" type="number" min="0" max="127" required defaultValue={slot.min} /></label>
        <label>Maximum <input name="max" type="number" min="0" max="127" required defaultValue={slot.max} /></label>
        <button type="submit">Save slot</button>
      </form>
    </aside></div>;
}

const graphWindow = 10000;

const CcCell = memo(function CcCell({ channel, controller, value, output, selected, onSelect }: {
  channel: number; controller: number; value: number | null; output: number | null; selected: boolean;
  onSelect: (channel: number, controller: number) => void;
}) {
  const difference = value !== null && output !== null ? output - value : 0;
  return <button data-cell={`${channel},${controller}`} className={`${selected ? 'selected' : ''} ${difference ? 'offset' : ''}`}
    aria-label={`Channel ${channel + 1} CC ${controller + 1}`}
    aria-description={`Input ${value ?? 'unknown'}, last calculated output ${output ?? 'unknown'}`}
    onClick={() => onSelect(channel, controller)}>{value ?? '—'}{difference > 0 ? `+${difference}` : difference < 0 ? difference : ''}</button>;
});

// Draws straight into the SVG each frame so scrolling stays smooth without re-rendering React.
function CcGraph({ engine, channel, cc }: EngineProps & { channel: number; cc: number }) {
  const input = useRef<SVGPolylineElement>(null);
  const output = useRef<SVGPolylineElement>(null);
  const dot = useRef<SVGCircleElement>(null);
  useEffect(() => {
    let frame = 0;
    let previous = ['', '', ''];
    const draw = () => {
      frame = requestAnimationFrame(draw);
      const now = Date.now();
      const inputPoints: string[] = [];
      const outputPoints: string[] = [];
      let lastX = '';
      let lastY = '';
      for (const entry of engine.history[channel][cc]) {
        if (now - entry.time > graphWindow) continue;
        const x = (400 - (now - entry.time) * 400 / graphWindow).toFixed(1);
        outputPoints.push(`${x},${127 - entry.after}`);
        if (entry.before !== null) inputPoints.push(`${x},${127 - entry.before}`);
        [lastX, lastY] = entry.before === null ? ['', ''] : [x, String(127 - entry.before)];
      }
      const next = [inputPoints.join(' '), outputPoints.join(' '), `${lastX},${lastY}`];
      if (next[0] !== previous[0]) input.current?.setAttribute('points', next[0]);
      if (next[1] !== previous[1]) output.current?.setAttribute('points', next[1]);
      if (next[2] !== previous[2] && dot.current) {
        dot.current.setAttribute('cx', lastX);
        dot.current.setAttribute('cy', lastY);
        dot.current.style.display = lastX ? '' : 'none';
      }
      previous = next;
    };
    draw();
    return () => cancelAnimationFrame(frame);
  }, [engine, channel, cc]);
  return <svg className="graph" viewBox="0 0 400 127" preserveAspectRatio="none" aria-label="Recent CC values">
    <polyline ref={input} /><polyline ref={output} className="output" /><circle ref={dot} r="2" style={{ display: 'none' }} /></svg>;
}

export function DiagnosticsView({ engine, selectedCell, onSelect }: EngineProps & {
  selectedCell: [number, number];
  onSelect: (channel: number, controller: number) => void;
}) {
  const [ch, cc] = selectedCell;
  const now = Date.now();
  const recent = engine.history[ch][cc].filter((entry) => now - entry.time <= graphWindow).length;
  const pattern = engine.observedPattern;
  return <div className="diagnostics"><section><h2>CC VALUES</h2>
    <p>LAST OBSERVED OP-Z PROJECT {pattern === null ? '—' : Math.floor(pattern / 16) + 1}
      &nbsp; PATTERN {pattern === null ? '—' : pattern % 16 + 1}</p>
    <p>16 × 16 (CHANNEL 1–16 × CC 1–16)</p>
    <div className="cc-grid-scroll"><div className="cc-grid"><span>CH / CC</span>{Array.from({ length: 16 }, (_, i) => <span key={i}>{i + 1}</span>)}
      {engine.values.map((row, channel) => <Fragment key={channel}><span>{channel + 1}</span>
        {row.map((value, controller) => <CcCell key={controller} channel={channel} controller={controller} value={value}
          output={engine.outputValues[channel][controller]} selected={ch === channel && cc === controller} onSelect={onSelect} />)}
      </Fragment>)}</div></div>
    <p><span className="accent">●</span> INPUT &nbsp; <span className="purple">●</span> OUTPUT DIFFERS</p></section>
    <section><h2>CC VALUE OVER TIME</h2><p>CHANNEL {ch + 1} / CC {cc + 1}</p>
      <CcGraph engine={engine} channel={ch} cc={cc} />
      <p>{recent} recent messages (last 10 seconds, up to 100)</p><h2>SELECTED CELL</h2>
      <p>CHANNEL {ch + 1} &nbsp; CC {cc + 1} &nbsp; VALUE {engine.values[ch][cc] ?? '—'}</p></section></div>;
}
