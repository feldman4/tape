import { Engine, newProject, validateProject } from './engine.js';
import './style.css';

const root = document.querySelector('#app');
root.innerHTML = `
  <header><h1>OP-Z <span>PADS</span></h1><nav aria-label="Views">
    <button data-tab="controller">Controller</button><button data-tab="scenes">Scenes</button>
    <button data-tab="drum">Drum</button><button data-tab="diagnostics">Diagnostics</button>
  </nav><span id="connection">MIDI OFFLINE</span></header>
  <section class="setup"><button id="enable">Enable MIDI</button>
    <label>iRig input <select id="irig-in"><option value="">None</option></select></label>
    <label>iRig output <select id="irig-out"><option value="">None</option></select></label>
    <label>OP-Z input <select id="opz-in"><option value="">None</option></select></label>
    <label>OP-Z output <select id="opz-out"><option value="">None</option></select></label>
  </section>
  <p id="message" role="status"></p><main id="view"></main>
  <footer>FIRST PASS · Mixer, performance FX and kit library are not implemented. See the manual for setup and limitations.</footer>
`;

const view = document.querySelector('#view');
const message = document.querySelector('#message');
const selects = Object.fromEntries(['irig-in', 'irig-out', 'opz-in', 'opz-out'].map((id) => [id, document.getElementById(id)]));
let access = null;
let tab = 'controller';
let selectedCell = [0, 0];
let saveError = '';
let releaseOutput = null;
let selectedOpzOutput = '';

function showError(error) {
  message.textContent = error instanceof Error ? error.message : String(error);
}

const engine = new Engine({
  send(destination, bytes) {
    const id = destination === 'opz' && releaseOutput !== null ? releaseOutput : selects[`${destination}-out`].value;
    const output = access?.outputs.get(id);
    if (!output || output.state !== 'connected') return;
    try { output.send(bytes); } catch (error) { showError(error); }
  },
  changed: render,
  save(project) {
    try {
      localStorage.setItem('opz-pads-project-v1', JSON.stringify(project));
      if (saveError && message.textContent === saveError) message.textContent = '';
      saveError = '';
    } catch (error) {
      saveError = `Could not save project: ${error.message}`;
      showError(saveError);
    }
  },
});

try {
  const saved = localStorage.getItem('opz-pads-project-v1');
  if (saved) {
    const project = JSON.parse(saved);
    if (!validateProject(project)) throw new Error('Stored project has an invalid or unsupported format');
    engine.project = project;
  }
} catch (error) { showError(error); }

function configurePorts() {
  if (!access) return;
  for (const input of access.inputs.values()) input.onmidimessage = null;
  const irig = access.inputs.get(selects['irig-in'].value);
  const opz = access.inputs.get(selects['opz-in'].value);
  if (irig && opz && irig.id === opz.id) {
    showError('Choose different iRig and OP-Z inputs.');
    return;
  }
  if (irig) irig.onmidimessage = (event) => engine.irig(event.data);
  if (opz) opz.onmidimessage = (event) => engine.opz(event.data);
  engine.refreshLeds();
  document.querySelector('#connection').textContent =
    irig && opz && selects['irig-out'].value && selects['opz-out'].value ? '● MIDI CONNECTED' : '● MIDI SETUP';
}

function listPorts() {
  if (!access) return;
  let lostPort = false;
  for (const [id, select] of Object.entries(selects)) {
    const old = select.value;
    const ports = id.endsWith('-in') ? access.inputs : access.outputs;
    select.replaceChildren(new Option('None', ''));
    for (const port of ports.values()) {
      if (port.state === 'connected') select.add(new Option(port.name || port.id, port.id));
    }
    select.value = old && ports.get(old)?.state === 'connected' ? old : '';
    if (old && !select.value) lostPort = true;
  }
  if (lostPort) {
    engine.releaseAll();
    engine.transport = 'unknown';
    selectedOpzOutput = selects['opz-out'].value;
    showError('A MIDI port disconnected. Select it again after reconnecting.');
  }
  configurePorts();
  render();
}

document.querySelector('#enable').addEventListener('click', async () => {
  try {
    if (!navigator.requestMIDIAccess) throw new Error('Web MIDI is unavailable. Use a supported Chromium browser over localhost or HTTPS.');
    access = await navigator.requestMIDIAccess();
    access.onstatechange = listPorts;
    listPorts();
    document.querySelector('#enable').textContent = 'MIDI enabled';
  } catch (error) { showError(error); }
});

for (const select of Object.values(selects)) select.addEventListener('change', () => {
  releaseOutput = selectedOpzOutput;
  engine.releaseAll();
  releaseOutput = null;
  if (select.id === 'opz-in') engine.transport = 'unknown';
  selectedOpzOutput = selects['opz-out'].value;
  configurePorts();
  render();
});

document.querySelector('nav').addEventListener('click', (event) => {
  const button = event.target.closest('[data-tab]');
  if (!button) return;
  tab = button.dataset.tab;
  render();
});

const padGrid = (compact = false) => {
  const leds = engine.leds();
  return `<div class="pad-grid ${compact ? 'compact' : ''}">${Array.from({ length: 16 }, (_, order) => {
    const index = (3 - Math.floor(order / 4)) * 4 + order % 4;
    const [red, green] = leds[index];
    return `<div class="pad ${red || green ? 'lit' : ''} ${engine.held[index] ? 'held' : ''}" style="--red:${red};--green:${green}" data-pad="${index + 1}">
      <span>${String(index + 1).padStart(2, '0')}</span>${engine.held[index] ? '<b>▼</b>' : ''}
    </div>`;
  }).join('')}</div>`;
};

function renderController() {
  return `<div class="controller">
    <div class="device-top"><div class="status-light">● <small>ON</small></div>
      <div class="small-control">SCENE</div><div class="small-control">FIX VEL</div>
      <div class="small-control ${engine.buttons[0] ? 'active' : ''}">1</div>
      <div class="small-control ${engine.buttons[1] ? 'active' : ''}">2</div>
      <strong>iRig <small>PADS</small></strong><div class="encoder ${engine.push ? 'active' : ''}">DATA</div>
    </div><div class="device-body"><aside><div class="knob">1</div><div class="knob">2</div>
      <div class="fader"><i style="bottom:${engine.fader / 127 * 100}%"></i></div><small>SLIDER</small></aside>
      ${padGrid()}</div></div>`;
}

function renderScenes() {
  return `<div class="scenes-layout"><aside><h2>CURRENT SCENE</h2><div class="big">${String(engine.scene + 1).padStart(2, '0')}</div>
    <p class="accent">${engine.project.scenes[engine.scene].type.toUpperCase()}</p><h2>PAD STATUS</h2>${padGrid(true)}
    <p>SELECT SCENE ON iRIG</p></aside><div class="scene-grid">${engine.project.scenes.map((item, index) =>
    `<article class="scene-card ${index === engine.scene ? 'selected' : ''}">
      <span>${String(index + 1).padStart(2, '0')}</span><div class="scene-icon">${item.type === 'mixer' ? '▥' : item.type === 'drum' ? '∿' : '◇'}</div>
      <strong class="${item.type}">${item.type.toUpperCase()}</strong>
      ${index ? `<label>Type <select data-scene-type="${index}"><option value="empty" ${item.type === 'empty' ? 'selected' : ''}>Empty</option><option value="drum" ${item.type === 'drum' ? 'selected' : ''}>Drum kit</option></select></label>` : '<small>FIXED MIXER</small>'}
    </article>`).join('')}</div><aside class="project"><h2>PROJECT</h2><p>16 SCENE SLOTS</p>
    <button id="export">Download project</button><label class="file-label">Load project<input type="file" id="import" accept=".json,application/json"></label>
    <button id="reset">New project</button><p>Changes are saved in browser storage. Download backups regularly.</p></aside></div>`;
}

function renderDrum() {
  const current = engine.project.scenes[engine.scene];
  if (current.type !== 'drum') return `<div class="empty-state"><h2>DRUM KIT</h2><p>Configure a scene as a drum kit, then select it on the iRig.</p></div>`;
  const names = ['KICK', 'SNARE', 'HI-HATS', 'SAMPLES'];
  return `<div class="drum-layout"><div class="drum-grid">${current.pads.map((pad, index) => {
    const color = pad ? ['yellow', 'red', 'orange', 'green'][pad.channel] : 'unassigned';
    return `<article class="drum-card ${color}"><span>${String(index + 1).padStart(2, '0')}</span>
      <b>${pad ? `T${pad.channel + 1}` : '—'}</b><h2>${pad ? names[pad.channel] : 'UNASSIGNED'}</h2>
      <p>${pad ? `MIDI NOTE ${pad.note}` : 'HOLD + PLAY OP-Z'}</p><small>MAX VEL ${pad ? pad.velocity : '—'}</small>
      <div class="bar"><i style="width:${pad ? pad.velocity / 127 * 100 : 0}%"></i></div></article>`;
  }).join('')}</div><aside class="mapping"><h2>PHYSICAL CONTROL MAPPING</h2>
    <table><thead><tr><th></th><th>POT 1</th><th>POT 2</th><th>DATA</th><th>PUSH + DATA</th><th>FADER</th></tr></thead>
    <tbody><tr><th>NONE</th><td>Pitch</td><td>HPF</td><td>LPF</td><td>LPF res</td><td>Max vel</td></tr>
    <tr><th>BUTTON 1</th><td>Start</td><td>Attack</td><td>Hold</td><td>Release</td><td>Compression</td></tr>
    <tr><th>BUTTON 2</th><td>FX 1</td><td>FX 2</td><td>Pan</td><td>Level</td><td>Compression</td></tr></tbody></table>
    <h2>NOTE ASSIGNMENT</h2><p>Stop the OP-Z, hold a pad and play a note on a drum track.</p>
    <p>TRANSPORT: <strong class="accent">${engine.transport.toUpperCase()}</strong></p><p>Hold pads while moving controls to audition changes.</p></aside></div>`;
}

function renderDiagnostics() {
  const [ch, cc] = selectedCell;
  const now = Date.now();
  const history = engine.history[ch][cc].filter((entry) => now - entry.time <= 10000);
  const points = history.map((entry) => `${400 - (now - entry.time) * 400 / 10000},${127 - entry.before}`).join(' ');
  const last = history.at(-1);
  return `<div class="diagnostics"><section><h2>CC VALUES</h2><p>16 × 16 (CHANNEL 1–16 × CC 1–16)</p>
    <div class="cc-grid"><span>CH / CC</span>${Array.from({ length: 16 }, (_, i) => `<span>${i + 1}</span>`).join('')}
    ${engine.values.map((row, channel) => `<span>${channel + 1}</span>${row.map((value, controller) =>
    `<button data-cell="${channel},${controller}" class="${ch === channel && cc === controller ? 'selected' : ''}" aria-label="Channel ${channel + 1} CC ${controller + 1}">${value ?? '—'}</button>`).join('')}`).join('')}</div>
    <p><span class="accent">●</span> NO OFFSET &nbsp; <span class="purple">●</span> OFFSET (NOT IMPLEMENTED)</p></section>
    <section><h2>CC VALUE OVER TIME</h2><p>CHANNEL ${ch + 1} / CC ${cc + 1}</p>
    <svg class="graph" viewBox="0 0 400 127" preserveAspectRatio="none" aria-label="Recent CC values"><polyline points="${points}"/>${last ? `<circle cx="${400 - (now - last.time) * 400 / 10000}" cy="${127 - last.before}" r="2"/>` : ''}</svg>
    <p>${history.length} recent messages (last 10 seconds, up to 100)</p><h2>SELECTED CELL</h2>
    <p>CHANNEL ${ch + 1} &nbsp; CC ${cc + 1} &nbsp; VALUE ${engine.values[ch][cc] ?? '—'}</p></section></div>`;
}

function render() {
  document.querySelector('.setup').hidden = tab !== 'controller';
  document.querySelectorAll('[data-tab]').forEach((button) => {
    button.classList.toggle('selected', button.dataset.tab === tab);
    button.setAttribute('aria-current', button.dataset.tab === tab ? 'page' : 'false');
  });
  view.innerHTML = tab === 'controller' ? renderController() : tab === 'scenes' ? renderScenes() : tab === 'drum' ? renderDrum() : renderDiagnostics();
}

view.addEventListener('change', async (event) => {
  const target = event.target;
  if (target.matches('[data-scene-type]')) {
    const index = Number(target.dataset.sceneType);
    if (engine.project.scenes[index].type !== 'empty' && !confirm('Replace this scene and its assignments?')) {
      render();
      return;
    }
    engine.setType(index, target.value);
  }
  if (target.id === 'import' && target.files[0]) {
    try {
      const project = JSON.parse(await target.files[0].text());
      if (!validateProject(project)) throw new Error('Invalid or unsupported project file');
      if (confirm('Replace the current project?')) engine.setProject(project);
    } catch (error) { showError(error); }
    target.value = '';
  }
});
view.addEventListener('click', (event) => {
  const cell = event.target.closest('[data-cell]');
  if (cell) {
    selectedCell = cell.dataset.cell.split(',').map(Number);
    render();
  }
  if (event.target.id === 'reset' && confirm('Replace the current project?')) engine.setProject(newProject());
  if (event.target.id === 'export') {
    const url = URL.createObjectURL(new Blob([JSON.stringify(engine.project, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'opz-pads-project.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
});
window.addEventListener('pagehide', () => engine.releaseAll());
render();
