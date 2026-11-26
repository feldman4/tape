import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { flipPadIndex } from '../src/irig-midi.ts';

const url = process.env.OPZ_PADS_URL ?? 'http://localhost:5173/tape/opz-pads/';
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1536, height: 1024 }, acceptDownloads: true });
await context.addInitScript(() => {
  const portState = (id) => location.search.includes(`no-${id}`) ? 'disconnected' : 'connected';
  const portName = (id) => id === 'irig' ? (location.search.includes('shared-name') ? 'iRig PADS OP-Z' : 'iRig PADS')
    : id === 'opz' ? 'OP-Z' : id === 'iac' ? 'IAC Driver Bus 1' : id;
  const inputs = new Map(['irig', 'opz', 'other'].map((id) => [id, { id, name: portName(id), state: portState(id), onmidimessage: null }]));
  const outputs = new Map(['irig', 'opz', 'iac', 'other'].map((id) => [id, {
    id, name: portName(id), state: portState(id), sent: [], send(data) { this.sent.push([...data]); },
  }]));
  const access = { inputs, outputs, onstatechange: null };
  window.mockMidi = {
    inputs, outputs, fail: location.search.includes('midi-error'),
    emit(port, data) { inputs.get(port).onmidimessage?.({ data: new Uint8Array(data) }); },
    setState(direction, port, state) {
      (direction === 'input' ? inputs : outputs).get(port).state = state;
      access.onstatechange?.();
    },
    addPort(direction, id, name) {
      const port = { id, name, state: 'connected' };
      if (direction === 'input') inputs.set(id, { ...port, onmidimessage: null });
      else outputs.set(id, { ...port, sent: [], send(data) { this.sent.push([...data]); } });
      access.onstatechange?.();
    },
  };
  Object.defineProperty(navigator, 'requestMIDIAccess', { configurable: true, value: async () => {
    if (window.mockMidi.fail) throw new Error('MIDI permission denied');
    return access;
  } });
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

try {
  await page.goto(url);
  assert.deepEqual(await page.locator('nav button').allTextContents(), ['Scene', 'Project', 'OP-Z', 'iRig MIDI']);
  assert.equal(await page.locator('.mixer-layout').count(), 1, 'Scene initially shows the mixer');
  assert.equal(await page.locator('.setup').isVisible(), false);
  assert.equal(await page.locator('#connection').isVisible(), false);
  await page.getByRole('button', { name: 'iRig MIDI', exact: true }).click();
  const header = await page.locator('header').evaluate((element) => ({
    height: element.getBoundingClientRect().height,
    titleSize: getComputedStyle(element.querySelector('h1')).fontSize,
    tabSize: getComputedStyle(element.querySelector('nav button')).fontSize,
  }));
  assert(header.height <= 50, 'desktop header is compact');
  assert.equal(header.titleSize, header.tabSize, 'app name matches navigation text size');
  for (const width of [1536, 560, 375]) {
    await page.setViewportSize({ width, height: 1024 });
    for (const control of await page.locator('.encoder, .knob').all()) {
      const { width: controlWidth, height: controlHeight } = await control.boundingBox();
      assert(Math.abs(controlWidth - controlHeight) < 1, `controller control is circular at ${width}px`);
    }
    if (width <= 560) {
      const controller = await page.locator('.controller').boundingBox();
      const check = await page.locator('.irig-check').boundingBox();
      assert(controller.y + controller.height <= check.y, `check stacks below controller at ${width}px`);
    }
  }
  await page.setViewportSize({ width: 1536, height: 1024 });
  await page.getByRole('button', { name: 'MIDI enabled' }).waitFor();
  const ledLog = page.locator('.led-log');
  assert.equal(await ledLog.isVisible(), false, 'LED log is hidden by default');
  await page.keyboard.press('Shift+Backquote');
  assert.equal(await ledLog.isVisible(), true, 'tilde shows the LED log');
  assert((await ledLog.locator('[role="log"] > div').count()) > 0, 'LED messages are recorded while hidden');
  await page.keyboard.press('Backquote');
  assert.equal(await ledLog.isVisible(), false, 'backtick hides the LED log');
  await page.locator('#irig-in').focus();
  await page.keyboard.press('Shift+Backquote');
  assert.equal(await ledLog.isVisible(), false, 'typing in a form control does not toggle the LED log');
  await page.locator('#irig-in').evaluate((element) => element.blur());
  assert.equal(await page.locator('#irig-in').inputValue(), 'irig', 'iRig input is selected on load');
  assert.equal(await page.locator('#irig-out').inputValue(), 'irig', 'iRig output is selected on load');
  assert.equal(await page.locator('#opz-in').inputValue(), 'opz', 'OP-Z input is selected on load');
  assert.equal(await page.locator('#opz-out').inputValue(), 'opz', 'OP-Z output is selected on load');
  assert.equal(await page.locator('#iac-out').inputValue(), 'iac', 'IAC output is selected on load');
  assert.equal(await page.locator('#connection').textContent(), '● MIDI CONNECTED');

  const lateIacPage = await context.newPage();
  await lateIacPage.goto(`${url}?no-iac`);
  await lateIacPage.getByRole('button', { name: 'iRig MIDI', exact: true }).click();
  await lateIacPage.getByRole('button', { name: 'MIDI enabled' }).waitFor();
  assert.equal(await lateIacPage.locator('#iac-out').inputValue(), '');
  await lateIacPage.evaluate(() => window.mockMidi.setState('output', 'iac', 'connected'));
  await lateIacPage.waitForFunction(() => document.querySelector('#iac-out').value === 'iac');
  await lateIacPage.evaluate(() => window.mockMidi.setState('output', 'iac', 'disconnected'));
  await lateIacPage.waitForFunction(() => document.querySelector('#iac-out').value === '');
  await lateIacPage.evaluate(() => window.mockMidi.setState('output', 'iac', 'connected'));
  await lateIacPage.waitForFunction(() => document.querySelector('#iac-out').value === 'iac');
  await lateIacPage.locator('#iac-out').selectOption('other');
  await lateIacPage.evaluate(() => window.mockMidi.setState('output', 'iac', 'disconnected'));
  await lateIacPage.evaluate(() => window.mockMidi.setState('output', 'iac', 'connected'));
  assert.equal(await lateIacPage.locator('#iac-out').inputValue(), 'other', 'manual Ableton output is preserved');
  await lateIacPage.close();

  const latePage = await context.newPage();
  await latePage.goto(`${url}?no-irig`);
  await latePage.getByRole('button', { name: 'iRig MIDI', exact: true }).click();
  await latePage.getByRole('button', { name: 'MIDI enabled' }).waitFor();
  assert.equal(await latePage.locator('#irig-in').inputValue(), '');
  await latePage.evaluate(() => window.mockMidi.setState('input', 'irig', 'connected'));
  await latePage.waitForFunction(() => document.querySelector('#irig-in').value === 'irig');
  await latePage.evaluate(() => window.mockMidi.setState('output', 'irig', 'connected'));
  await latePage.waitForFunction(() => document.querySelector('#irig-out').value === 'irig');
  assert.equal(await latePage.evaluate(() => window.mockMidi.outputs.get('irig').sent.length), 0, 'check mode does not refresh scene LEDs');
  await latePage.getByRole('button', { name: 'Scene', exact: true }).click();
  assert.equal(await latePage.evaluate(() => window.mockMidi.outputs.get('irig').sent.length), 32, 'leaving the check refreshes LEDs');
  await latePage.getByRole('button', { name: 'iRig MIDI', exact: true }).click();
  await latePage.locator('#irig-in').selectOption('other');
  await latePage.locator('#irig-out').selectOption('');
  await latePage.evaluate(() => window.mockMidi.setState('input', 'opz', 'disconnected'));
  assert.equal(await latePage.locator('#irig-in').inputValue(), 'other', 'automatic selection preserves a manual input');
  assert.equal(await latePage.locator('#irig-out').inputValue(), '', 'unrelated device changes preserve a cleared selection');
  await latePage.close();

  const lateOpzPage = await context.newPage();
  await lateOpzPage.goto(`${url}?no-opz`);
  await lateOpzPage.getByRole('button', { name: 'iRig MIDI', exact: true }).click();
  await lateOpzPage.getByRole('button', { name: 'MIDI enabled' }).waitFor();
  assert.equal(await lateOpzPage.locator('#opz-in').inputValue(), '', 'unrelated input is not selected');
  assert.equal(await lateOpzPage.locator('#opz-out').inputValue(), '', 'unrelated output is not selected');
  await lateOpzPage.evaluate(() => window.mockMidi.setState('input', 'opz', 'connected'));
  await lateOpzPage.waitForFunction(() => document.querySelector('#opz-in').value === 'opz');
  await lateOpzPage.evaluate(() => window.mockMidi.setState('output', 'opz', 'connected'));
  await lateOpzPage.waitForFunction(() => document.querySelector('#opz-out').value === 'opz');
  await lateOpzPage.evaluate(() => window.mockMidi.setState('input', 'opz', 'disconnected'));
  await lateOpzPage.waitForFunction(() => document.querySelector('#opz-in').value === '');
  await lateOpzPage.evaluate(() => window.mockMidi.setState('input', 'opz', 'connected'));
  await lateOpzPage.waitForFunction(() => document.querySelector('#opz-in').value === 'opz');
  await lateOpzPage.evaluate(() => window.mockMidi.setState('output', 'opz', 'disconnected'));
  await lateOpzPage.waitForFunction(() => document.querySelector('#opz-out').value === '');
  await lateOpzPage.evaluate(() => window.mockMidi.setState('output', 'opz', 'connected'));
  await lateOpzPage.waitForFunction(() => document.querySelector('#opz-out').value === 'opz');
  await lateOpzPage.locator('#opz-in').selectOption('other');
  await lateOpzPage.locator('#opz-out').selectOption('');
  await lateOpzPage.evaluate(() => window.mockMidi.setState('input', 'irig', 'disconnected'));
  assert.equal(await lateOpzPage.locator('#opz-in').inputValue(), 'other', 'manual OP-Z input is preserved');
  assert.equal(await lateOpzPage.locator('#opz-out').inputValue(), '', 'cleared OP-Z output is preserved on unrelated changes');
  await lateOpzPage.evaluate(() => window.mockMidi.addPort('input', 'opz2', 'op-z MIDI'));
  assert.equal(await lateOpzPage.locator('#opz-in').inputValue(), 'other', 'new OP-Z does not replace a manual input');
  await lateOpzPage.evaluate(() => window.mockMidi.addPort('output', 'opz2', 'op-z MIDI'));
  await lateOpzPage.waitForFunction(() => document.querySelector('#opz-out').value === 'opz2');
  await lateOpzPage.close();

  const sharedPage = await context.newPage();
  await sharedPage.goto(`${url}?no-opz&shared-name`);
  await sharedPage.getByRole('button', { name: 'iRig MIDI', exact: true }).click();
  await sharedPage.getByRole('button', { name: 'MIDI enabled' }).waitFor();
  assert.equal(await sharedPage.locator('#irig-in').inputValue(), 'irig');
  assert.equal(await sharedPage.locator('#opz-in').inputValue(), '', 'auto-selection does not share an input');
  await sharedPage.close();

  const deniedPage = await context.newPage();
  await deniedPage.goto(`${url}?midi-error`);
  await deniedPage.getByText('MIDI permission denied').waitFor();
  await deniedPage.getByRole('button', { name: 'iRig MIDI', exact: true }).click();
  await deniedPage.evaluate(() => { window.mockMidi.fail = false; });
  await deniedPage.getByRole('button', { name: 'Enable MIDI' }).click();
  await deniedPage.getByRole('button', { name: 'MIDI enabled' }).waitFor();
  assert.equal(await deniedPage.locator('#irig-in').inputValue(), 'irig', 'retry selects iRig after access is granted');
  assert.equal(await deniedPage.locator('#message').textContent(), '', 'successful retry clears the MIDI error');
  await deniedPage.close();

  for (const [id, value] of [['irig-in', 'irig'], ['irig-out', 'irig'], ['opz-in', 'opz'], ['opz-out', 'opz']]) {
    await page.locator(`#${id}`).selectOption(value);
  }
  for (const tab of ['Project', 'Scene', 'OP-Z']) {
    await page.getByRole('button', { name: tab, exact: true }).click();
    assert.equal(await page.locator('.setup').isVisible(), false, `MIDI setup is hidden on ${tab}`);
    assert.equal(await page.locator('#connection').isVisible(), false, `MIDI status is hidden on ${tab}`);
  }
  await page.getByRole('button', { name: 'iRig MIDI', exact: true }).click();
  assert.equal(await page.locator('.setup').isVisible(), true, 'MIDI setup is visible on iRig MIDI');
  assert.equal(await page.locator('#connection').isVisible(), true);
  for (const [id, value] of [['irig-in', 'irig'], ['irig-out', 'irig'], ['opz-in', 'opz'], ['opz-out', 'opz']]) {
    assert.equal(await page.locator(`#${id}`).inputValue(), value, `${id} stays selected across views`);
  }
  const emit = (port, data) => page.evaluate(({ port, data }) => window.mockMidi.emit(port, data), { port, data });
  const emitApp = (port, [status, ...data]) => {
    const kind = status & 0xf0;
    const mapped = kind === 0x80 || kind === 0x90 || kind === 0xd0 || (kind === 0xb0 && data[0] === 96);
    return emit(port, [mapped ? kind + flipPadIndex(status & 15) : status, ...data]);
  };
  const sent = (port) => page.evaluate((port) => window.mockMidi.outputs.get(port).sent, port);
  const clear = () => page.evaluate(() => { for (const output of window.mockMidi.outputs.values()) output.sent.length = 0; });
  await page.getByRole('button', { name: 'Scene', exact: true }).click();
  assert.equal(await page.locator('.mixer-details .pad').first().getAttribute('data-pad'), '1',
    'controller grid starts with app pad 1 at the top left');
  await emit('irig', [0x9c, 60, 100]);
  await page.locator('.mixer-details .pad[data-pad="1"].held').waitFor();
  await emit('irig', [0x8c, 60, 0]);
  await emit('irig', [0x90, 60, 100]);
  await page.locator('.mixer-details .pad[data-pad="13"].held').waitFor();
  await emit('irig', [0x80, 60, 0]);
  await clear();
  await emit('opz', [0xf8]);
  await emit('opz', [0xb0, 16, 100]);
  assert.deepEqual(await sent('iac'), [[0xf8], [0xb0, 16, 100]], 'OP-Z MIDI is forwarded to IAC');
  await page.getByLabel('Track 1 level 100').waitFor();
  assert.equal(await page.getByRole('heading', { name: 'MUTE GROUPS — 1' }).count(), 1);
  assert.equal(await page.getByLabel('Group 1, track 1: unknown').count(), 1);
  await clear();
  await emitApp('irig', [0x90, 60, 100]);
  await emitApp('irig', [0xb0, 96, 64]);
  assert.deepEqual(await sent('opz'), [], 'fader does not change OP-Z levels');
  assert.deepEqual(await sent('iac'), [[0xb0, 16, 50]], 'fader changes only the virtual output');
  await emit('opz', [0xb0, 16, 100]);
  assert.deepEqual(await sent('iac'), [[0xb0, 16, 50], [0xb0, 16, 50]], 'OP-Z feedback retains the fader scale');
  const levelBar = page.getByLabel('Track 1 level 50');
  assert(Math.abs(parseFloat(await levelBar.locator('.base-level').evaluate((bar) => bar.style.height)) - 100 / 127 * 100) < 0.001);
  assert(Math.abs(parseFloat(await levelBar.locator('.final-level').evaluate((bar) => bar.style.height)) - 50 / 127 * 100) < 0.001);
  assert.deepEqual(await page.locator('.mixer-details .pad[data-pad="1"]').evaluate((pad) =>
    [pad.style.getPropertyValue('--red'), pad.style.getPropertyValue('--green')]), ['34', '21']);
  await emitApp('irig', [0xb0, 96, 127]);
  await emitApp('irig', [0x80, 60, 0]);
  const buttonStatus = (index) => page.locator(`.mixer-buttons [data-button="${index}"]`);
  assert.equal(await buttonStatus(1).getAttribute('aria-label'), 'Button 1: released');
  assert.equal(await buttonStatus(2).getAttribute('aria-label'), 'Button 2: released');
  await clear();
  await emitApp('irig', [0xb0, 90, 127]);
  await page.getByLabel('Button 1: pressed').waitFor();
  assert.equal(await buttonStatus(1).getAttribute('class'), 'mixer-button active');
  await emitApp('irig', [0x90, 60, 100]);
  await page.keyboard.press('Shift+Backquote');
  await page.waitForFunction(() => {
    const entries = document.querySelectorAll('.led-log [role="log"] > div');
    return entries[0]?.textContent.includes('PAD 1 · RED 0 · SENT')
      && entries[1]?.textContent.includes('PAD 1 · GREEN 0 · SENT');
  });
  assert.equal(await page.locator('.led-log [role="log"] > div').count() <= 100, true, 'LED log is bounded');
  assert((await sent('opz')).some((message) => message.join() === '176,53,1'), 'unknown track is muted on first toggle');
  assert.equal(await page.getByLabel('Group 1, track 1: muted').count(), 1);
  assert.deepEqual(await sent('iac'), [[0xb0, 120, 0], [0xb0, 123, 0]], 'mute stops notes on the virtual bus');
  await emitApp('irig', [0x80, 60, 0]);
  await emitApp('irig', [0xb0, 90, 0]);
  await page.getByLabel('Button 1: released').waitFor();
  await emitApp('irig', [0xb0, 91, 127]);
  await page.getByLabel('Button 2: pressed').waitFor();
  assert.equal(await page.locator('.mixer-details .pad.lit').count(), 10);
  assert.deepEqual(await page.locator('.mixer-details .pad[data-pad="1"]').evaluate((pad) =>
    [pad.style.getPropertyValue('--red'), pad.style.getPropertyValue('--green')]), ['127', '35']);
  assert.deepEqual(await page.locator('.mixer-details .pad[data-pad="2"]').evaluate((pad) =>
    [pad.style.getPropertyValue('--red'), pad.style.getPropertyValue('--green')]), ['7', '5']);
  assert.equal(await page.locator('.mixer-details .pad[data-pad="11"]').evaluate((pad) =>
    pad.classList.contains('lit')), false);
  await emitApp('irig', [0x92, 60, 100]);
  assert.deepEqual(await page.locator('.mixer-details .pad[data-pad="3"]').evaluate((pad) =>
    [pad.style.getPropertyValue('--red'), pad.style.getPropertyValue('--green')]), ['127', '35']);
  assert.deepEqual(await page.locator('.mixer-details .pad[data-pad="1"]').evaluate((pad) =>
    [pad.style.getPropertyValue('--red'), pad.style.getPropertyValue('--green')]), ['7', '5']);
  await emitApp('irig', [0x82, 60, 0]);
  await emitApp('irig', [0xb0, 91, 0]);
  await page.getByLabel('Button 2: released').waitFor();
  assert.equal(await page.locator('.mixer-details .pad.lit').count(), 16, 'track display returns after release');
  await page.getByRole('button', { name: 'iRig MIDI', exact: true }).click();
  await page.locator('#opz-out').selectOption('iac');
  assert.equal(await page.locator('#opz-out').inputValue(), 'opz', 'IAC and OP-Z outputs cannot be shared');
  async function screenshot(name) {
    if (!process.env.OPZ_PADS_SCREENSHOTS) return;
    await mkdir(process.env.OPZ_PADS_SCREENSHOTS, { recursive: true });
    await page.screenshot({ path: join(process.env.OPZ_PADS_SCREENSHOTS, `${name}.png`), fullPage: true });
  }

  await page.locator('#opz-in').selectOption('');
  await clear();
  await page.getByLabel('Scene to check').selectOption('2');
  const checkButton = (name) => page.getByRole('button', { name: new RegExp(`^${name}, `) });
  const selectCheck = async (name) => checkButton(name).click();
  const checkComplete = async (name, complete) => {
    const label = `${name}, ${complete ? 'complete' : 'not complete'}`;
    await page.waitForFunction((expected) => Array.from(document.querySelectorAll('.check-list button'))
      .some((button) => button.getAttribute('aria-label') === expected), label);
  };
  assert.equal(await page.locator('.check-list button').count(), 7, 'all check sections and color explorer are available');
  const controllerBox = await page.locator('.controller').boundingBox();
  const checkBox = await page.locator('.irig-check').boundingBox();
  assert(controllerBox.x + controllerBox.width <= checkBox.x, 'controller is left of the check on desktop');
  await emit('irig', [0xb1, 94, 0]);
  await emit('irig', [0xb1, 95, 127]);
  const checkPot1 = page.getByRole('img', { name: 'Pot 1 position 0' });
  const checkPot2 = page.getByRole('img', { name: 'Pot 2 position 127' });
  await checkPot1.waitFor();
  await checkPot2.waitFor();
  assert.equal(await checkPot1.locator('i').evaluate((element) => element.style.transform), 'rotate(-135deg)');
  assert.equal(await checkPot2.locator('i').evaluate((element) => element.style.transform), 'rotate(135deg)');
  await emit('irig', [0x90, 60, 100]);
  await page.locator('.controller .pad[data-pad="13"].held').waitFor();
  await emit('irig', [0x80, 60, 0]);
  await emit('irig', [0xb1, 96, 64]);
  assert(Math.abs(parseFloat(await page.locator('.controller .fader i').evaluate((element) => element.style.bottom)) - 64 / 127 * 100) < 0.001);
  await emit('irig', [0xb1, 93, 127]);
  await page.locator('.controller .encoder.active').waitFor();
  await emit('irig', [0xb1, 93, 0]);
  assert.equal((await sent('opz')).length, 0, 'controller preview does not play notes');
  await selectCheck('Simultaneous holds');
  await emit('irig', [0x90, 60, 100]);
  await selectCheck('Controls and modifiers');
  await selectCheck('Simultaneous holds');
  assert.match(await page.locator('.irig-check').textContent(), /Press and hold pad 1/, 'interrupted hold restarts');
  for (const data of [[0x90, 60, 100], [0x91, 60, 100], [0x80, 60, 0], [0x81, 60, 0]]) await emit('irig', data);
  await checkComplete('Simultaneous holds', true);
  await selectCheck('Scene selection');
  await page.getByRole('button', { name: 'Restart this check' }).click();
  await emit('irig', [0xb0, 90, 127]);
  await checkComplete('Scene selection', false);
  await checkComplete('Simultaneous holds', true);
  await emit('irig', [0xb1, 90, 1]);
  await checkComplete('Scene selection', false);
  await emit('irig', [0xb1, 96, 64]);
  await checkComplete('Scene selection', true);
  await selectCheck('Pads and pressure');
  await emit('irig', [0xb0, 96, 64]);
  await page.getByText(/Different scene detected; checks reset/).waitFor();
  await checkComplete('Scene selection', false);
  await emit('irig', [0xb1, 96, 64]);
  await checkComplete('Scene selection', true);
  await selectCheck('Pads and pressure');
  await emit('irig', [0x91, 60, 100]);
  assert.match(await page.locator('.irig-check').textContent(), /Pad 1 of 16: press and hold/, 'wrong pad channel is rejected');
  await emit('irig', [0x90, 48, 100]);
  assert.match(await page.locator('.irig-check').textContent(), /Pad 1 of 16: press and hold/, 'old pad note is rejected');
  await emit('irig', [0x90, 60, 100]);
  await emit('irig', [0x80, 60, 0]);
  assert.match(await page.locator('.irig-check').textContent(), /Pad 1 of 16: press and hold/, 'release without pressure requires retry');
  for (const data of [[0x90, 60, 100], [0xd0, 64], [0x80, 60, 0]]) await emit('irig', data);
  await selectCheck('Controls and modifiers');
  await selectCheck('Pads and pressure');
  assert.match(await page.locator('.irig-check').textContent(), /Pad 2 of 16/, 'completed pads remain checked when switching sections');
  for (let channel = 1; channel < 16; channel++) {
    await emit('irig', [0x90 + channel, 60, 100]);
    await emit('irig', [0xd0 + channel, 64]);
    await emit('irig', [0x80 + channel, 60, 0]);
  }
  await checkComplete('Pads and pressure', true);
  assert.equal((await sent('opz')).length, 0, 'test input does not play OP-Z notes');
  await selectCheck('Simultaneous holds');
  for (const data of [[0x90, 60, 100], [0x91, 60, 100], [0x80, 60, 0], [0x81, 60, 0]]) await emit('irig', data);
  await checkComplete('Simultaneous holds', true);
  await selectCheck('Controls and modifiers');
  for (const data of [[0xb0, 94, 64], [0xbf, 95, 64], [0xb1, 96, 64]]) await emit('irig', data);
  await page.getByText(/Move DATA clockwise.*any channel, CC 92/).waitFor();
  await emit('irig', [0xb0, 7, 1]);
  assert.match(await page.locator('.irig-check').textContent(), /Move DATA clockwise.*CC 92/, 'old encoder CC is rejected');
  for (const data of [
    [0xb0, 92, 1], [0xbf, 92, 127],
    [0xb0, 90, 127], [0xbf, 90, 0], [0xb0, 91, 127], [0xbf, 91, 0],
  ]) await emit('irig', data);
  await page.getByText(/Press and hold DATA push.*CC 93/).waitFor();
  await emit('irig', [0xb1, 93, 1]);
  assert.match(await page.locator('.irig-check').textContent(), /Press and hold DATA push/, 'invalid push value is rejected');
  await emit('irig', [0xb1, 93, 127]);
  await emit('irig', [0xb1, 93, 0]);
  await checkComplete('Controls and modifiers', true);
  await selectCheck('Combined gestures');
  await emit('irig', [0x90, 60, 100]);
  await emit('irig', [0xb1, 90, 127]);
  await emit('irig', [0x80, 60, 0]);
  assert.match(await page.locator('.irig-check').textContent(), /Press and hold pad 1/, 'early release restarts the combination');
  for (const data of [
    [0x90, 60, 100], [0xb0, 90, 127], [0xbf, 94, 65], [0xb0, 90, 0], [0x80, 60, 0],
    [0x90, 60, 100], [0xb0, 91, 127], [0xbf, 95, 65], [0xb0, 91, 0], [0x80, 60, 0],
    [0xb0, 93, 127], [0xbf, 92, 1], [0xb0, 92, 127], [0xbf, 93, 0],
  ]) await emit('irig', data);
  await checkComplete('Combined gestures', true);
  await page.getByRole('button', { name: 'LED colors', exact: true }).click();
  await page.getByLabel('Palette color').selectOption({ label: 'Drum Kick (held)' });
  await clear();
  await page.getByRole('button', { name: 'Send color' }).click();
  assert.deepEqual(await sent('irig'), [[0xb0, 94, 100], [0xb0, 95, 127]], 'physical pad 1 receives palette color');
  await page.getByLabel('Physical pad').selectOption('16');
  await page.getByRole('button', { name: 'Send color' }).click();
  assert.deepEqual((await sent('irig')).slice(-2), [[0xb0, 76, 100], [0xb0, 77, 127]], 'physical pad 16 maps correctly');
  await page.getByLabel('Color source').selectOption('gradient');
  for (const [name, low, high] of [
    ['Mixer fader scale', [7, 5], [0, 127]],
    ['Mixer level (active or unknown)', [0, 16], [0, 127]],
    ['Mixer level (muted)', [0, 0], [0, 127]],
    ['Mixer pan', [64, 0], [0, 127]],
    ['FX note pressure', [0, 20], [0, 127]],
    ['FX custom pressure', [20, 0], [127, 0]],
    ['FX scene depth', [20, 6], [127, 35]],
  ]) {
    await page.getByLabel('Gradient', { exact: true }).selectOption({ label: name });
    for (const [position, [red, green]] of [[0, low], [127, high]]) {
      await page.getByLabel('Gradient position').fill(String(position));
      assert.match(await page.locator('.irig-colors').textContent(), new RegExp(`Red ${red}, green ${green}`), `${name} at ${position}`);
    }
  }
  await page.getByLabel('Gradient', { exact: true }).selectOption({ label: 'Mixer pan' });
  await page.getByLabel('Gradient position').fill('64');
  assert.match(await page.locator('.irig-colors').textContent(), /Red 32, green 64/);
  await page.getByLabel('Target').selectOption('button');
  await page.getByLabel('Physical button').selectOption('2');
  await clear();
  await page.getByRole('button', { name: 'Send color' }).click();
  assert.deepEqual(await sent('irig'), [[0xb0, 26, 64], [0xb0, 27, 32]], 'button receives gradient color');
  await page.getByLabel('Physical button').selectOption('1');
  await page.evaluate(() => {
    const output = window.mockMidi.outputs.get('irig');
    output.originalSend = output.send;
    output.send = (data) => { if (data[1] === 25) throw new Error('color output failure'); output.originalSend(data); };
  });
  await page.getByRole('button', { name: 'Send color' }).click();
  assert.match(await page.getByRole('alert').textContent(), /color output failure/);
  await page.evaluate(() => { const output = window.mockMidi.outputs.get('irig'); output.send = output.originalSend; });
  await clear();
  await selectCheck('Combined gestures');
  const restored = await sent('irig');
  assert(restored.some((message) => message[1] === 24 && message[2] === 0), 'partially sent button is cleared');
  assert(restored.some((message) => message[1] === 26 && message[2] === 0), 'tested button is cleared');
  assert.equal(restored.filter((message) => message[1] >= 70).length, 32, 'scene pad LEDs are restored');
  await checkComplete('Combined gestures', true);
  await selectCheck('LED output');
  await page.evaluate(() => {
    const output = window.mockMidi.outputs.get('irig');
    output.originalSend = output.send;
    output.send = () => { throw new Error('test output failure'); };
  });
  await page.getByRole('button', { name: 'Start LED sequence' }).click();
  await page.getByRole('alert').waitFor();
  assert.match(await page.getByRole('alert').textContent(), /test output failure/);
  assert.equal(await page.getByRole('button', { name: 'Yes, it matches' }).isDisabled(), true);
  await page.evaluate(() => { const output = window.mockMidi.outputs.get('irig'); output.send = output.originalSend; });
  await clear();
  await page.getByRole('button', { name: 'Start LED sequence' }).click();
  await page.getByText('LED sequence running...').waitFor();
  await selectCheck('Pads and pressure');
  await page.waitForFunction(() => window.mockMidi.outputs.get('irig').sent.some((m) => m[1] === 24 && m[2] === 0));
  await clear();
  await page.waitForTimeout(200);
  assert.equal((await sent('irig')).length, 0, 'leaving the LED check cancels scheduled frames');
  await selectCheck('LED output');
  await checkComplete('LED output', false);
  await page.getByRole('button', { name: 'Start LED sequence' }).click();
  await page.getByText('LED sequence running...').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Yes, it matches' }).isDisabled(), true, 'cannot confirm a running sequence');
  await page.waitForFunction(() => !Array.from(document.querySelectorAll('button'))
    .find((button) => button.textContent === 'Yes, it matches').disabled, null, { timeout: 20000 });
  await checkComplete('LED output', false);
  await page.getByRole('button', { name: 'No, it does not match' }).click();
  await checkComplete('LED output', false);
  await clear();
  const started = Date.now();
  await page.getByRole('button', { name: 'Start LED sequence' }).click();
  await page.getByText('LED sequence running...').waitFor();
  await page.waitForTimeout(9500);
  assert.equal(await page.getByRole('button', { name: 'Yes, it matches' }).isDisabled(), true, 'sequence lasts approximately ten seconds');
  await page.waitForFunction(() => !Array.from(document.querySelectorAll('button'))
    .find((button) => button.textContent === 'Yes, it matches').disabled, null, { timeout: 10000 });
  assert(Date.now() - started < 20000, 'sequence finishes in approximately ten seconds');
  const ledCcs = [70, 72, 74, 76, 78, 80, 82, 84, 86, 88, 90, 92, 94, 96, 98, 100];
  const colors = [[0, 32], [0, 127], [32, 96], [64, 64], [96, 32], [127, 0], [32, 0], [0, 0]];
  const expected = ledCcs.flatMap((cc) => colors.flatMap(([red, green]) => [
    [0xb0, cc, green], [0xb0, cc + 1, red],
    [0xb0, 24, green], [0xb0, 25, red], [0xb0, 26, green], [0xb0, 27, red],
  ]));
  const messages = await sent('irig');
  assert.deepEqual(messages.slice(0, 32), ledCcs.flatMap((cc) => [[0xb0, cc, 0], [0xb0, cc + 1, 0]]), 'sequence clears all pads first');
  assert.deepEqual(messages.slice(32, 32 + expected.length), expected, 'every pad and button displays the full color and brightness sequence');
  assert.deepEqual(messages.slice(32 + expected.length, 38 + expected.length), [
    [0xb0, 100, 0], [0xb0, 101, 0], [0xb0, 24, 0], [0xb0, 25, 0], [0xb0, 26, 0], [0xb0, 27, 0],
  ], 'sequence clears the last pad and both buttons');
  await page.getByRole('button', { name: 'Yes, it matches' }).click();
  await checkComplete('LED output', true);
  assert.match(await page.locator('.irig-check').textContent(), /does not verify other scenes/);
  await selectCheck('Pads and pressure');
  await checkComplete('Pads and pressure', true);
  await page.getByRole('button', { name: 'Restart this check' }).click();
  await checkComplete('Pads and pressure', false);
  await checkComplete('LED output', true);
  await page.getByLabel('Scene to check').selectOption('3');
  await checkComplete('LED output', false);
  await clear();
  await page.locator('#opz-in').selectOption('opz');
  await page.getByRole('button', { name: 'Scene', exact: true }).click();
  assert.equal((await sent('irig')).length, 32, 'leaving the check restores the scene LEDs');
  assert.match(await page.locator('#message').textContent(), /synchronize after the check/);
  await page.getByRole('button', { name: 'Project', exact: true }).click();
  await page.locator('[data-scene-type="1"]').selectOption('drum');
  await screenshot('scenes');
  await page.getByRole('button', { name: 'Scene', exact: true }).click();
  assert.equal(await page.locator('.mixer-layout').count(), 1);
  await clear();
  await emitApp('irig', [0xb1, 96, 64]);
  assert((await sent('irig')).some((m) => m[0] === 0xb0 && m[1] === 94), 'scene change reconciles pad LEDs');
  await page.locator('.drum-card').first().waitFor();
  assert.equal(await page.locator('.drum-card').count(), 16, 'Scene switches to the active drum kit');
  await emitApp('irig', [0x90, 60, 100]);
  await page.locator('.drum-card').first().locator('.drum-flash').waitFor();
  assert.equal(await page.locator('.drum-card').nth(1).locator('.drum-flash').count(), 0, 'only the hit pad flashes');
  await emit('opz', [0x91, 40, 100]);
  assert.equal(await page.locator('.drum-card').first().getByText('UNASSIGNED').count(), 1, 'learning requires a known stopped transport');
  await emit('opz', [0xfc]);
  await emit('opz', [0x91, 40, 100]);
  await page.locator('.drum-card').first().getByText('SNARE').waitFor();
  assert.equal(await page.locator('.drum-card').first().getByText('SNARE').count(), 1);
  assert((await sent('irig')).some((m) => m[1] === 71 && m[2] === 127), 'snare LED red');
  await emitApp('irig', [0x80, 60, 0]);
  await emitApp('irig', [0x91, 60, 100]);
  await emit('opz', [0x9c, 48, 100]);
  await page.locator('.drum-card').nth(1).getByText('PERF FX').waitFor();
  assert.equal(await page.locator('.drum-card').nth(1).locator('b').textContent(), 'T13');
  assert(await page.locator('.drum-card').nth(1).evaluate((card) => card.classList.contains('green')));
  await emitApp('irig', [0x81, 60, 0]);
  await clear();
  await emitApp('irig', [0x91, 60, 100]);
  assert((await sent('opz')).some((m) => m.join() === '156,48,100'), 'performance FX note reaches OP-Z');
  assert(!(await sent('iac')).some((m) => m[0] === 0x9c || m[0] === 0x8c), 'performance FX notes do not reach Ableton');
  await emitApp('irig', [0x81, 60, 0]);
  assert((await sent('opz')).some((m) => m.join() === '140,48,0'), 'performance FX note-off reaches OP-Z');
  assert(!(await sent('iac')).some((m) => m[0] === 0x9c || m[0] === 0x8c), 'performance FX note-off does not reach Ableton');
  await clear();
  await emitApp('irig', [0x90, 60, 100]);
  assert((await sent('opz')).some((m) => m.join() === '145,40,100'), 'pad plays learned note');
  assert((await sent('iac')).some((m) => m.join() === '145,40,100'), 'pad plays directly on Ableton');
  await emitApp('irig', [0xb1, 96, 90]);
  await page.locator('.drum-card').first().getByText('MAX VEL 90').waitFor();
  assert.match(await page.locator('.drum-card').first().textContent(), /MAX VEL 90/, 'first fader movement sets velocity');
  const velocityBar = page.locator('.drum-card').first().locator('.bar');
  assert.equal(await velocityBar.getAttribute('aria-label'), 'Pad 1 maximum velocity 90, played velocity 100');
  await emitApp('irig', [0x80, 60, 0]);
  await emitApp('irig', [0x90, 60, 64]);
  await page.getByLabel('Pad 1 maximum velocity 90, played velocity 45').waitFor();
  const barWidths = await velocityBar.locator('i').evaluateAll((bars) => bars.map((bar) => parseFloat(bar.style.width)));
  assert(Math.abs(barWidths[0] - 90 / 127 * 100) < 0.001, 'neutral range shows maximum velocity');
  assert(Math.abs(barWidths[1] - 45 / 127 * 100) < 0.001, 'colored range shows the scaled strike velocity');
  const neutralColor = 'rgb(24, 43, 54)';
  assert.deepEqual(await velocityBar.locator('i').evaluateAll((bars) => bars.map((bar) => getComputedStyle(bar).backgroundColor)),
    [neutralColor, 'rgb(255, 35, 81)'], 'maximum uses dark gray and the played range uses the track color');
  assert.equal(await velocityBar.evaluate((bar) => getComputedStyle(bar).backgroundColor), 'rgba(0, 0, 0, 0)',
    'there is no full-width background track');
  await emitApp('irig', [0xd0, 10]);
  assert.equal(await velocityBar.getAttribute('aria-label'), 'Pad 1 maximum velocity 90, played velocity 45');
  await emitApp('irig', [0x80, 60, 0]);
  await velocityBar.locator('.played-velocity').waitFor({ state: 'detached' });
  assert.equal(await velocityBar.getAttribute('aria-label'), 'Pad 1 maximum velocity 90', 'idle bar restores the maximum');
  assert.equal(await velocityBar.locator('.base-velocity').evaluate((bar) => getComputedStyle(bar).backgroundColor), neutralColor,
    'idle maximum remains neutral');
  await emitApp('irig', [0x90, 60, 100]);
  await emitApp('irig', [0xb1, 94, 64]);
  await emitApp('irig', [0xb1, 94, 66]);
  assert((await sent('opz')).some((m) => m.join() === '177,1,66'), 'pot sends absolute pitch to OP-Z');
  assert((await sent('iac')).some((m) => m.join() === '177,1,66'), 'pot sends absolute pitch to Ableton');
  await page.waitForTimeout(140);
  assert((await sent('opz')).filter((m) => m.join() === '145,40,90').length >= 2, 'moving a parameter repeats the note');
  await page.waitForTimeout(180);
  await velocityBar.locator('.played-velocity').waitFor({ state: 'detached' });
  const countAfterStop = (await sent('opz')).length;
  await page.waitForTimeout(160);
  assert.equal((await sent('opz')).length, countAfterStop, 'audition stops after movement');
  await emitApp('irig', [0xb1, 90, 127]);
  await emitApp('irig', [0xb1, 91, 127]);
  await emitApp('irig', [0xb1, 95, 64]);
  await emitApp('irig', [0xb1, 95, 63]);
  assert((await sent('opz')).some((m) => m.join() === '177,6,63'), 'button 1 selects attack and excludes button 2');
  await emitApp('irig', [0x80, 60, 0]);
  assert((await sent('opz')).some((m) => m.join() === '129,40,0'), 'release sends note off');
  assert((await sent('iac')).some((m) => m.join() === '129,40,0'), 'release sends note off to Ableton');
  await screenshot('drum-kit');
  await emitApp('irig', [0x90, 60, 100]);
  await clear();
  await page.getByRole('button', { name: 'iRig MIDI', exact: true }).click();
  assert((await sent('opz')).some((m) => m.join() === '129,40,0'), 'entering the check releases sounding notes');
  await screenshot('controller');
  await page.locator('#opz-out').selectOption('irig');
  await page.locator('#opz-out').selectOption('opz');
  await page.getByRole('button', { name: 'Scene', exact: true }).click();
  await emitApp('irig', [0xb1, 94, 64]);
  await emitApp('irig', [0x90, 60, 100]);
  await clear();
  await page.evaluate(() => window.mockMidi.setState('input', 'irig', 'disconnected'));
  await page.waitForFunction(() => document.querySelector('#message').textContent.includes('disconnected'));
  assert((await sent('opz')).some((m) => m.join() === '129,40,0'), 'input disconnect releases sounding notes');
  await page.evaluate(() => window.mockMidi.setState('input', 'irig', 'connected'));
  await page.waitForFunction(() => window.mockMidi.inputs.get('irig').onmidimessage !== null);
  await emitApp('irig', [0x90, 60, 100]);
  await clear();
  await emitApp('irig', [0xb0, 96, 64]);
  assert((await sent('opz')).some((m) => m.join() === '129,40,0'), 'scene change releases sounding notes');
  await emit('opz', [0xb1, 5, 75]);
  assert.equal(await page.locator('.mixer-layout').count(), 1, 'Scene switches back to the mixer');
  await emitApp('irig', [0xb2, 96, 64]);
  assert.equal(await page.getByRole('heading', { name: 'EMPTY SCENE' }).count(), 1, 'unconfigured scenes show an empty state');
  await page.getByRole('button', { name: 'OP-Z', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Channel 2 CC 5' }).textContent(), '75');
  await page.getByRole('button', { name: 'Channel 2 CC 5' }).click();
  assert.match(await page.locator('.diagnostics').textContent(), /1 recent messages/);
  await screenshot('diagnostics');
  await page.reload();
  await page.getByRole('button', { name: 'Project', exact: true }).click();
  assert.equal(await page.locator('[data-scene-type="1"]').inputValue(), 'drum', 'project persists after reload');
  const project = JSON.parse(await page.evaluate(() => localStorage.getItem('opz-pads-project-v1')));
  assert.deepEqual(project.scenes[1].pads[0], { channel: 1, note: 40, velocity: 90 });
  assert.deepEqual(project.scenes[1].pads[1], { channel: 12, note: 48, velocity: 127 }, 'performance FX assignments persist');
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.locator('[data-scene-type="1"]').selectOption('empty');
  assert.equal(await page.locator('[data-scene-type="1"]').inputValue(), 'drum', 'cancel keeps the scene type');
  const projectLibrary = page.getByRole('region', { name: 'Project library' });
  const kitLibrary = page.getByRole('region', { name: 'Kit library' });
  const dropFiles = async (target, files) => target.locator('.library-list').evaluate((element, entries) => {
    const transfer = new DataTransfer();
    for (const entry of entries) transfer.items.add(new File([entry.content], entry.name, { type: 'application/json' }));
    const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer });
    element.dispatchEvent(over);
    if (!over.defaultPrevented) throw new Error('Drop target did not accept dragover');
    element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, files);
  await dropFiles(projectLibrary, [
    { name: 'Should Not Import.json', content: JSON.stringify(project) },
    { name: 'bad.json', content: '{"version":1,"scenes":[]}' },
  ]);
  await page.waitForFunction(() => document.querySelector('#message').textContent.includes('Invalid or unsupported project'));
  assert.equal(await projectLibrary.getByRole('button', { name: 'Should Not Import', exact: true }).count(), 0,
    'a batch containing an invalid file is not partially imported');
  project.scenes[1].pads[0].velocity = 45;
  await dropFiles(projectLibrary, [{ name: 'project_Night Mix.json', content: JSON.stringify(project) }]);
  await projectLibrary.getByRole('button', { name: 'Night Mix', exact: true }).waitFor();
  assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem('opz-pads-project-v1'))).scenes[1].pads[0].velocity, 90,
    'import adds to the library without replacing the current project');
  const replacement = structuredClone(project);
  replacement.scenes[1].pads[0].velocity = 77;
  const rejectedDialog = page.waitForEvent('dialog');
  await dropFiles(projectLibrary, [{ name: 'project_Night Mix.json', content: JSON.stringify(replacement) }]);
  await (await rejectedDialog).dismiss();
  assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem('opz-pads-library-v1')))
    .projects.find((item) => item.name === 'Night Mix').value.scenes[1].pads[0].velocity, 45);
  const acceptedDialog = page.waitForEvent('dialog');
  await dropFiles(projectLibrary, [{ name: 'project_Night Mix.json', content: JSON.stringify(replacement) }]);
  await (await acceptedDialog).accept();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('opz-pads-library-v1'))
    .projects.find((item) => item.name === 'Night Mix').value.scenes[1].pads[0].velocity === 77);
  const restoreDialog = page.waitForEvent('dialog');
  await dropFiles(projectLibrary, [{ name: 'project_Night Mix.json', content: JSON.stringify(project) }]);
  await (await restoreDialog).accept();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('opz-pads-library-v1'))
    .projects.find((item) => item.name === 'Night Mix').value.scenes[1].pads[0].velocity === 45);
  page.once('dialog', (dialog) => dialog.accept());
  await projectLibrary.getByRole('button', { name: 'Night Mix', exact: true }).click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('opz-pads-project-v1')).scenes[1].pads[0].velocity === 45);

  await page.getByLabel('Project name').fill('Snapshot');
  await page.getByRole('button', { name: 'Save project' }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download project Snapshot' }).click();
  const download = await downloadPromise;
  assert.equal(download.suggestedFilename(), 'project_Snapshot.json');
  const chunks = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk);
  assert.equal(JSON.parse(Buffer.concat(chunks).toString()).scenes[1].pads[0].velocity, 45);
  await page.getByLabel('Project name').fill('R&D / 50% Mix');
  await page.getByRole('button', { name: 'Save project' }).click();
  const namedDownloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download project R&D / 50% Mix' }).click();
  const namedDownload = await namedDownloadPromise;
  assert.equal(namedDownload.suggestedFilename(), 'project_R&D %2F 50%25 Mix.json');
  const duplicateDialog = page.waitForEvent('dialog');
  await dropFiles(projectLibrary, [{ name: namedDownload.suggestedFilename(), content: JSON.stringify(project) }]);
  await (await duplicateDialog).dismiss();
  assert.equal(await projectLibrary.getByRole('button', { name: 'R&D / 50% Mix', exact: true }).count(), 1,
    'escaped filenames round-trip and declined replacements keep the existing entry');
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Delete project R&D / 50% Mix' }).click();
  assert.equal(await page.getByRole('button', { name: 'Save kit' }).isDisabled(), true, 'mixer cannot be saved as a kit');
  await emitApp('irig', [0xb1, 96, 64]);
  await page.getByLabel('Kit name').fill('Snapshot');
  await page.getByRole('button', { name: 'Save kit' }).click();
  assert.equal(await page.getByRole('button', { name: 'Snapshot', exact: true }).count(), 2);
  const kitDownloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download kit Snapshot' }).click();
  const kitDownload = await kitDownloadPromise;
  assert.equal(kitDownload.suggestedFilename(), 'kit_Snapshot.json');
  const kitChunks = [];
  for await (const chunk of await kitDownload.createReadStream()) kitChunks.push(chunk);
  const kitFile = JSON.parse(Buffer.concat(kitChunks).toString());
  assert.equal(kitFile.kit.pads[0].velocity, 45);
  assert.equal(kitFile.kit.pads[1].channel, 12, 'exported kits retain performance FX assignments');
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('button', { name: 'Save kit' }).click();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Init kit' }).click();
  assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem('opz-pads-project-v1'))).scenes[1].pads[0], null);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('region', { name: 'Kit library' }).getByRole('button', { name: 'Snapshot', exact: true }).click();
  assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem('opz-pads-project-v1'))).scenes[1].pads[0].velocity, 45);
  await page.reload();
  await page.getByRole('button', { name: 'Project', exact: true }).click();
  await page.getByRole('button', { name: 'Snapshot', exact: true }).first().waitFor();
  assert.equal(await page.getByRole('button', { name: 'Snapshot', exact: true }).count(), 2, 'both libraries persist');
  assert.equal(await page.getByRole('region', { name: 'Kit library' }).getByRole('button', { name: 'Snapshot', exact: true }).isDisabled(), true);
  const kitDrag = kitLibrary.locator('.kit-drag').filter({ hasText: 'Snapshot' });
  const sceneCards = page.locator('.scene-card');
  await kitDrag.dragTo(sceneCards.nth(0));
  assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem('opz-pads-project-v1'))).scenes[0].type, 'mixer',
    'dragging a kit cannot replace the mixer');
  await kitDrag.dragTo(sceneCards.nth(3));
  assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem('opz-pads-project-v1'))).scenes[3].pads[0].velocity, 45,
    'a kit can be dragged to a non-current scene while the mixer is active');
  assert.match(await page.locator('.scenes-layout aside').first().textContent(), /01\s*MIXER/,
    'dropping a kit does not change the active scene');
  await page.reload();
  await page.getByRole('button', { name: 'Project', exact: true }).click();
  assert.equal(await page.locator('[data-scene-type="3"]').inputValue(), 'drum', 'dropped kits persist after reload');
  await dropFiles(kitLibrary, [
    { name: 'Low Bass.json', content: JSON.stringify(kitFile) },
    { name: 'kit_Snare Unit.json', content: JSON.stringify(kitFile) },
  ]);
  await page.getByRole('button', { name: 'Download kit Low Bass' }).waitFor();
  await page.getByRole('button', { name: 'Download kit Snare Unit' }).waitFor();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Delete kit Low Bass' }).click();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Delete kit Snare Unit' }).click();
  await emitApp('irig', [0xb2, 96, 64]);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('region', { name: 'Kit library' }).getByRole('button', { name: 'Snapshot', exact: true }).click();
  assert.deepEqual(JSON.parse(await page.evaluate(() => localStorage.getItem('opz-pads-project-v1'))).scenes[2].pads[0],
    { channel: 1, note: 40, velocity: 45 }, 'kit loads into an empty current scene');
  await dropFiles(kitLibrary, [{ name: 'bad.json', content: '{"version":1,"kit":{"type":"drum","pads":[]}}' }]);
  await page.waitForFunction(() => document.querySelector('#message').textContent.includes('Invalid or unsupported kit'));
  kitFile.kit.pads[0].velocity = 30;
  await dropFiles(kitLibrary, [{ name: 'kit_Night Beat.json', content: JSON.stringify(kitFile) }]);
  await kitLibrary.getByRole('button', { name: 'Night Beat', exact: true }).waitFor();
  assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem('opz-pads-project-v1'))).scenes[2].pads[0].velocity, 45,
    'importing a kit does not replace the current scene');
  await kitLibrary.locator('.kit-drag').filter({ hasText: 'Night Beat' }).dragTo(sceneCards.nth(3));
  assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem('opz-pads-project-v1'))).scenes[3].pads[0].velocity, 30,
    'dropping a kit replaces an occupied scene without confirmation');
  page.once('dialog', (dialog) => dialog.accept());
  await kitLibrary.getByRole('button', { name: 'Night Beat', exact: true }).click();
  assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem('opz-pads-project-v1'))).scenes[2].pads[0].velocity, 30);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('region', { name: 'Kit library' }).getByRole('button', { name: 'Snapshot', exact: true }).click();
  assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem('opz-pads-project-v1'))).scenes[2].pads[0].velocity, 45,
    'editing the current kit does not change the saved snapshot');
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('region', { name: 'Project library' }).getByRole('button', { name: 'Snapshot', exact: true }).click();
  assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem('opz-pads-project-v1'))).scenes[2].type, 'empty');
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Init project' }).click();
  assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem('opz-pads-project-v1'))).scenes[1].type, 'empty');
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('region', { name: 'Project library' }).getByRole('button', { name: 'Snapshot', exact: true }).click();
  assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem('opz-pads-project-v1'))).scenes[1].pads[0].velocity, 45);
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('button', { name: 'Delete project Snapshot' }).click();
  assert.equal(await page.getByRole('button', { name: 'Delete project Snapshot' }).count(), 1);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Delete kit Snapshot' }).click();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Delete project Snapshot' }).click();
  assert.equal(await page.getByRole('button', { name: 'Snapshot', exact: true }).count(), 0);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Delete kit Night Beat' }).click();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Delete project Night Mix' }).click();

  await page.getByLabel('Project name').fill('');
  await page.getByLabel('Project name').press('1');
  assert.equal(await page.getByLabel('Project name').inputValue(), '1', 'number keys type into names instead of switching views');
  await page.getByLabel('Project name').blur();
  await page.getByRole('button', { name: 'iRig MIDI', exact: true }).click();
  await page.keyboard.press('2');
  const projectTab = page.getByRole('button', { name: 'Project', exact: true });
  assert.equal(await projectTab.getAttribute('aria-current'), 'page');
  assert.equal(await projectTab.evaluate((button) => document.activeElement === button), true, 'shortcut moves focused navigation to selected view');
  const focusStyle = await projectTab.evaluate((button) => ({
    outline: getComputedStyle(button).outlineStyle,
    decoration: getComputedStyle(button).textDecorationLine,
    visible: button.matches(':focus-visible'),
  }));
  assert.equal(focusStyle.outline, 'none', 'focused navigation has no outline box');
  assert(focusStyle.visible && focusStyle.decoration.includes('underline'), 'keyboard focus remains visible');
  await page.keyboard.press('Tab');
  const opzTab = page.getByRole('button', { name: 'OP-Z', exact: true });
  assert.equal(await opzTab.evaluate((button) => document.activeElement === button && button.matches(':focus-visible')), true,
    'navigation remains keyboard accessible');
  for (const [key, tab] of [['1', 'Scene'], ['2', 'Project'], ['3', 'OP-Z'], ['4', 'iRig MIDI']]) {
    await page.keyboard.press(key);
    assert.equal(await page.getByRole('button', { name: tab, exact: true }).getAttribute('aria-current'), 'page');
  }
  await page.keyboard.press('1');
  assert.equal(await page.getByRole('button', { name: 'Scene', exact: true }).getAttribute('aria-current'), 'page');
  await page.getByRole('button', { name: 'Project', exact: true }).click();
  const fxType = page.locator('[data-scene-type="15"]');
  if (await fxType.inputValue() !== 'empty') page.once('dialog', (dialog) => dialog.accept());
  await fxType.selectOption('fx');
  await emitApp('irig', [0xbf, 96, 64]);
  await page.getByRole('button', { name: 'Scene', exact: true }).click();
  await emitApp('irig', [0xbf, 94, 0]);
  await emitApp('irig', [0xbf, 95, 127]);
  await page.getByRole('img', { name: 'Pot 1 position 0' }).waitFor();
  await page.getByRole('img', { name: 'Pot 2 position 127' }).waitFor();
  await page.locator('input[name="channel"]').fill('5');
  await page.locator('input[name="cc"]').fill('70');
  await page.locator('input[name="min"]').fill('20');
  await page.locator('input[name="max"]').fill('100');
  await page.getByRole('button', { name: 'Save slot' }).click();
  assert.deepEqual(JSON.parse(await page.evaluate(() => localStorage.getItem('opz-pads-fx-slots-v1'))).slots[0],
    { channel: 4, cc: 70, min: 20, max: 100 });
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'opz-pads-fx-slots-v1') throw new Error('Storage unavailable');
      return original.call(this, key, value);
    };
    window.restoreStorage = () => { Storage.prototype.setItem = original; };
  });
  await page.locator('input[name="cc"]').fill('71');
  await page.getByRole('button', { name: 'Save slot' }).click();
  assert.match(await page.locator('#message').textContent(), /Could not save custom slots: Storage unavailable/);
  assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem('opz-pads-fx-slots-v1'))).slots[0].cc, 70);
  await page.evaluate(() => window.restoreStorage());
  await page.locator('input[name="cc"]').fill('70');
  await emitApp('irig', [0x90, 60, 127]);
  await emitApp('irig', [0xbf, 93, 127]);
  await emitApp('irig', [0xbf, 92, 1]);
  await emitApp('irig', [0xbf, 93, 0]);
  await page.getByText('SLOT 1', { exact: true }).waitFor();
  assert((await sent('iac')).some((bytes) => bytes.join() === '180,70,100'),
    'failed slot save leaves the active custom slot unchanged');
  await page.getByRole('img', { name: 'Pad 1 pressure 100%' }).waitFor();
  await emitApp('irig', [0xd0, 64]);
  await page.getByRole('img', { name: 'Pad 1 pressure 50%' }).waitFor();
  await emitApp('irig', [0x80, 60, 0]);
  await emitApp('irig', [0xbf, 95, 100]);
  await emitApp('irig', [0x91, 60, 127]);
  for (const value of [40, 60, 50]) await emit('opz', [0xb0, 1, value]);
  await page.getByRole('img', { name: 'Pad 2 depth 100%' }).waitFor();
  await emitApp('irig', [0xbf, 92, 30]);
  await page.getByRole('button', { name: 'OP-Z', exact: true }).click();
  const ccCell = page.getByRole('button', { name: 'Channel 1 CC 1', exact: true });
  const cellText = (text, message) => page.waitForFunction((text) =>
    document.querySelector('[data-cell="0,0"]').textContent === text, text, { timeout: 2000 }).catch(() => {
    throw new Error(message);
  });
  await cellText('50+30', 'grid shows a positive calculated difference');
  assert.equal(await ccCell.getAttribute('aria-description'), 'Input 50, last calculated output 80');
  await emitApp('irig', [0xbf, 92, 68]);
  await cellText('50-30', 'grid shows a negative calculated difference');
  await emit('opz', [0xb0, 1, 10]);
  await cellText('10-10', 'grid reflects clamping in the output difference');
  assert.equal(await page.getByRole('button', { name: 'Channel 1 CC 2', exact: true }).textContent(), '—');
  for (const width of [1536, 900, 375, 320]) {
    await page.setViewportSize({ width, height: 1024 });
    const sizes = await ccCell.evaluate((cell) => ({
      fits: cell.scrollWidth <= cell.clientWidth,
      pageFits: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      scrollable: document.querySelector('.cc-grid-scroll').scrollWidth > document.querySelector('.cc-grid-scroll').clientWidth,
    }));
    assert(sizes.fits && sizes.pageFits, `CC grid values fit without page overflow at ${width}px`);
    if (width <= 375) assert(sizes.scrollable, `CC grid scrolls at ${width}px`);
  }
  await page.setViewportSize({ width: 1536, height: 1024 });
  await emitApp('irig', [0xbf, 92, 30]);
  await emit('opz', [0xb0, 1, 50]);
  await cellText('50', 'zero difference shows only the input');
  const points = await page.locator('.graph polyline.output').getAttribute('points');
  assert(points && points.split(' ').length >= 2, 'graph draws recent output without React renders');
  await page.getByRole('button', { name: 'Scene', exact: true }).click();
  await emitApp('irig', [0xbf, 95, 114]);
  await page.getByRole('img', { name: /B unassigned/ }).waitFor();
  await emitApp('irig', [0xbf, 95, 115]);
  await emitApp('irig', [0xbf, 93, 127]);
  await emitApp('irig', [0xbf, 93, 0]);
  await emitApp('irig', [0x81, 60, 0]);
  await emitApp('irig', [0xbf, 96, 0]);
  await page.getByRole('img', { name: 'Pad 2 depth 0%' }).waitFor();
  await page.getByRole('img', { name: 'Crossfader 0 of 127; A unassigned; B pad 2' }).waitFor();
  await emitApp('irig', [0xbf, 96, 64]);
  const fxDepth = page.getByRole('img', { name: 'Pad 2 depth 50%' });
  await fxDepth.waitFor();
  const fxCrossfader = page.getByRole('img', { name: 'Crossfader 64 of 127; A unassigned; B pad 2' });
  await fxCrossfader.waitFor();
  const depthWidth = await fxDepth.locator('i').evaluate((element) => element.getBoundingClientRect().width / element.parentElement.getBoundingClientRect().width);
  assert(Math.abs(depthWidth - 64 / 127) < 0.01, 'scene depth bar reflects the actual blend');
  const faderPosition = await fxCrossfader.locator('.fader i').evaluate((element) => parseFloat(element.style.bottom));
  assert(Math.abs(faderPosition - 64 / 127 * 100) < 0.01, 'crossfader marker reflects the physical position');
  assert.deepEqual(await fxCrossfader.locator('.fx-crossfader-end strong').allTextContents(), ['B', 'A'], 'fader ends are labeled top to bottom');
  assert(!((await fxCrossfader.textContent()).includes('127')), 'fader does not show a numeric fraction');
  const fxControls = page.locator('.fx-pad-layout .controller-controls');
  assert.deepEqual(await fxControls.locator('.knob span').allTextContents(), ['1', '2'], 'FX view reuses the iRig knob layout');
  for (const width of [1536, 900, 375, 320]) {
    await page.setViewportSize({ width, height: 1024 });
    const faderBox = await fxCrossfader.boundingBox();
    const padBox = await page.locator('.fx-pad-layout .drum-grid').boundingBox();
    const knobBoxes = await Promise.all((await fxControls.locator('.knob').all()).map((knob) => knob.boundingBox()));
    const pads = page.locator('.fx-pad-layout .drum-card');
    const rowStart = await pads.nth(width <= 560 ? 12 : 8).boundingBox();
    const rowEnd = await pads.nth(width <= 560 ? 14 : 12).boundingBox();
    const track = await fxCrossfader.locator('.fader').boundingBox();
    assert(faderBox.x + faderBox.width <= padBox.x, `crossfader is left of pads at ${width}px`);
    assert(knobBoxes[0].y + knobBoxes[0].height < knobBoxes[1].y && knobBoxes[1].y + knobBoxes[1].height < faderBox.y,
      `knobs sit above the fader at ${width}px`);
    assert(Math.abs(faderBox.y - rowStart.y) < 1 && Math.abs(faderBox.y + faderBox.height - rowEnd.y - rowEnd.height) < 1,
      `crossfader spans the bottom two pad rows at ${width}px`);
    assert(track.height >= faderBox.height * 0.75, `fader track fills the lower rows at ${width}px`);
    const layout = await page.locator('.fx-pad-layout').evaluate((element) => ({ width: element.clientWidth, scroll: element.scrollWidth }));
    assert(layout.scroll <= layout.width, `FX layout fits at ${width}px`);
  }
  await page.setViewportSize({ width: 1536, height: 1024 });
  await page.getByRole('button', { name: 'iRig MIDI', exact: true }).click();
  await page.getByRole('img', { name: 'Pot 1 position 0' }).waitFor();
  await emitApp('irig', [0xbf, 94, 30]);
  await page.getByRole('img', { name: 'Pot 1 position 30' }).waitFor();
  await page.getByRole('button', { name: 'Scene', exact: true }).click();
  await page.getByRole('img', { name: 'Pot 1 position 30' }).waitFor();
  assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem('opz-pads-project-v1'))).scenes[15].pads[0].slot, 0);
  await page.getByRole('button', { name: 'OP-Z', exact: true }).click();
  await page.keyboard.press('Backquote');
  assert.equal(await ledLog.isVisible(), true);
  await page.getByRole('button', { name: 'Scene', exact: true }).click();
  assert.equal(await ledLog.isVisible(), false, 'gutter is hidden on Scene even when enabled');
  await page.keyboard.press('Backquote');
  await page.getByRole('button', { name: 'Project', exact: true }).click();
  assert.equal(await ledLog.isVisible(), false, 'gutter is hidden on Project');
  await page.getByRole('button', { name: 'OP-Z', exact: true }).click();
  assert.equal(await ledLog.isVisible(), true, 'gutter visibility is preserved on other pages');
  await page.keyboard.press('Backquote');
  await page.getByRole('button', { name: 'Scene', exact: true }).click();
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#enable').textContent === 'MIDI enabled');
  await emitApp('irig', [0xbf, 96, 64]);
  assert.equal(await page.locator('input[name="cc"]').inputValue(), '70', 'custom slots survive reload');
  await page.getByRole('button', { name: 'Project', exact: true }).click();
  await page.getByLabel('Project name').fill('Cannot save');
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'opz-pads-library-v1') throw new Error('Storage unavailable');
      return original.call(this, key, value);
    };
    window.restoreStorage = () => { Storage.prototype.setItem = original; };
  });
  await page.getByRole('button', { name: 'Save project' }).click();
  assert.match(await page.locator('#message').textContent(), /Could not save library: Storage unavailable/);
  assert.equal(await page.getByRole('button', { name: 'Cannot save', exact: true }).count(), 0);
  await page.evaluate(() => {
    window.restoreStorage();
    localStorage.setItem('opz-pads-library-v1', '{"version":99}');
  });
  await page.reload();
  await page.getByRole('button', { name: 'Project', exact: true }).click();
  await page.getByText('Could not load library: Stored library has an invalid or unsupported format').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Save project' }).isDisabled(), true);
  assert.equal(await page.evaluate(() => localStorage.getItem('opz-pads-library-v1')), '{"version":99}',
    'invalid stored libraries are not overwritten');
  await page.evaluate(() => {
    localStorage.setItem('opz-pads-library-v1', JSON.stringify({ version: 1, projects: [], kits: [] }));
  });
  await page.reload();
  await page.getByRole('button', { name: 'Project', exact: true }).click();
  await page.getByText('Could not load library: Stored library has an invalid or unsupported format').waitFor();
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('opz-pads-library-v1')).version), 1,
    'unsupported v1 libraries are not overwritten');
  await page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem('opz-pads-project-v1'));
    project.version = 1;
    localStorage.setItem('opz-pads-project-v1', JSON.stringify(project));
    localStorage.removeItem('opz-pads-library-v1');
  });
  await page.reload();
  await page.getByText('Stored project has an invalid or unsupported format').waitFor();
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('opz-pads-project-v1')).version), 1,
    'unsupported v1 working projects are not overwritten');
  assert.deepEqual(errors, []);
  console.log('OP-Z Pads mocked MIDI workflow passed.');
} finally {
  await browser.close();
}
