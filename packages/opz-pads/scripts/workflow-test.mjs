import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

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
  await latePage.getByRole('button', { name: 'MIDI enabled' }).waitFor();
  assert.equal(await latePage.locator('#irig-in').inputValue(), '');
  await latePage.evaluate(() => window.mockMidi.setState('input', 'irig', 'connected'));
  await latePage.waitForFunction(() => document.querySelector('#irig-in').value === 'irig');
  await latePage.evaluate(() => window.mockMidi.setState('output', 'irig', 'connected'));
  await latePage.waitForFunction(() => document.querySelector('#irig-out').value === 'irig');
  assert.equal(await latePage.evaluate(() => window.mockMidi.outputs.get('irig').sent.length), 32, 'connecting output refreshes LEDs');
  await latePage.locator('#irig-in').selectOption('other');
  await latePage.locator('#irig-out').selectOption('');
  await latePage.evaluate(() => window.mockMidi.setState('input', 'opz', 'disconnected'));
  assert.equal(await latePage.locator('#irig-in').inputValue(), 'other', 'automatic selection preserves a manual input');
  assert.equal(await latePage.locator('#irig-out').inputValue(), '', 'unrelated device changes preserve a cleared selection');
  await latePage.close();

  const lateOpzPage = await context.newPage();
  await lateOpzPage.goto(`${url}?no-opz`);
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
  await sharedPage.getByRole('button', { name: 'MIDI enabled' }).waitFor();
  assert.equal(await sharedPage.locator('#irig-in').inputValue(), 'irig');
  assert.equal(await sharedPage.locator('#opz-in').inputValue(), '', 'auto-selection does not share an input');
  await sharedPage.close();

  const deniedPage = await context.newPage();
  await deniedPage.goto(`${url}?midi-error`);
  await deniedPage.getByText('MIDI permission denied').waitFor();
  await deniedPage.evaluate(() => { window.mockMidi.fail = false; });
  await deniedPage.getByRole('button', { name: 'Enable MIDI' }).click();
  await deniedPage.getByRole('button', { name: 'MIDI enabled' }).waitFor();
  assert.equal(await deniedPage.locator('#irig-in').inputValue(), 'irig', 'retry selects iRig after access is granted');
  assert.equal(await deniedPage.locator('#message').textContent(), '', 'successful retry clears the MIDI error');
  await deniedPage.close();

  for (const [id, value] of [['irig-in', 'irig'], ['irig-out', 'irig'], ['opz-in', 'opz'], ['opz-out', 'opz']]) {
    await page.locator(`#${id}`).selectOption(value);
  }
  for (const tab of ['Scenes', 'Mixer', 'Drum', 'Diagnostics']) {
    await page.getByRole('button', { name: tab, exact: true }).click();
    assert.equal(await page.locator('.setup').isVisible(), false, `MIDI setup is hidden on ${tab}`);
  }
  await page.getByRole('button', { name: 'Controller', exact: true }).click();
  assert.equal(await page.locator('.setup').isVisible(), true, 'MIDI setup is visible on Controller');
  for (const [id, value] of [['irig-in', 'irig'], ['irig-out', 'irig'], ['opz-in', 'opz'], ['opz-out', 'opz']]) {
    assert.equal(await page.locator(`#${id}`).inputValue(), value, `${id} stays selected across views`);
  }
  const emit = (port, data) => page.evaluate(({ port, data }) => window.mockMidi.emit(port, data), { port, data });
  const sent = (port) => page.evaluate((port) => window.mockMidi.outputs.get(port).sent, port);
  const clear = () => page.evaluate(() => { for (const output of window.mockMidi.outputs.values()) output.sent.length = 0; });
  await clear();
  await emit('opz', [0xf8]);
  await emit('opz', [0xb0, 16, 100]);
  assert.deepEqual(await sent('iac'), [[0xf8], [0xb0, 16, 100]], 'OP-Z MIDI is forwarded to IAC');
  await page.getByRole('button', { name: 'Mixer', exact: true }).click();
  assert.equal(await page.getByLabel('Track 1 level 100').count(), 1);
  assert.equal(await page.getByRole('heading', { name: 'MUTE GROUPS — 1' }).count(), 1);
  assert.equal(await page.getByLabel('Group 1, track 1: unknown').count(), 1);
  await clear();
  await emit('irig', [0x90, 60, 100]);
  await emit('irig', [0xb0, 96, 64]);
  assert.deepEqual(await sent('opz'), [], 'fader does not change OP-Z levels');
  assert.deepEqual(await sent('iac'), [[0xb0, 16, 50]], 'fader changes only the virtual output');
  await emit('opz', [0xb0, 16, 100]);
  assert.deepEqual(await sent('iac'), [[0xb0, 16, 50], [0xb0, 16, 50]], 'OP-Z feedback retains the fader scale');
  const levelBar = page.getByLabel('Track 1 level 50');
  assert(Math.abs(parseFloat(await levelBar.locator('.base-level').evaluate((bar) => bar.style.height)) - 100 / 127 * 100) < 0.001);
  assert(Math.abs(parseFloat(await levelBar.locator('.final-level').evaluate((bar) => bar.style.height)) - 50 / 127 * 100) < 0.001);
  assert.deepEqual(await page.locator('.mixer-details .pad[data-pad="1"]').evaluate((pad) =>
    [pad.style.getPropertyValue('--red'), pad.style.getPropertyValue('--green')]), ['34', '21']);
  await emit('irig', [0xb0, 96, 127]);
  await emit('irig', [0x80, 60, 0]);
  const buttonStatus = (index) => page.locator(`.mixer-buttons [data-button="${index}"]`);
  assert.equal(await buttonStatus(1).getAttribute('aria-label'), 'Button 1: released');
  assert.equal(await buttonStatus(2).getAttribute('aria-label'), 'Button 2: released');
  await clear();
  await emit('irig', [0xb0, 90, 127]);
  await page.getByLabel('Button 1: pressed').waitFor();
  assert.equal(await buttonStatus(1).getAttribute('class'), 'mixer-button active');
  await emit('irig', [0x90, 60, 100]);
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
  await emit('irig', [0x80, 60, 0]);
  await emit('irig', [0xb0, 90, 0]);
  await page.getByLabel('Button 1: released').waitFor();
  await emit('irig', [0xb0, 91, 127]);
  await page.getByLabel('Button 2: pressed').waitFor();
  assert.equal(await page.locator('.mixer-details .pad.lit').count(), 10);
  assert.deepEqual(await page.locator('.mixer-details .pad[data-pad="1"]').evaluate((pad) =>
    [pad.style.getPropertyValue('--red'), pad.style.getPropertyValue('--green')]), ['127', '35']);
  assert.deepEqual(await page.locator('.mixer-details .pad[data-pad="2"]').evaluate((pad) =>
    [pad.style.getPropertyValue('--red'), pad.style.getPropertyValue('--green')]), ['7', '5']);
  assert.equal(await page.locator('.mixer-details .pad[data-pad="11"]').evaluate((pad) =>
    pad.classList.contains('lit')), false);
  await emit('irig', [0x92, 60, 100]);
  assert.deepEqual(await page.locator('.mixer-details .pad[data-pad="3"]').evaluate((pad) =>
    [pad.style.getPropertyValue('--red'), pad.style.getPropertyValue('--green')]), ['127', '35']);
  assert.deepEqual(await page.locator('.mixer-details .pad[data-pad="1"]').evaluate((pad) =>
    [pad.style.getPropertyValue('--red'), pad.style.getPropertyValue('--green')]), ['7', '5']);
  await emit('irig', [0x82, 60, 0]);
  await emit('irig', [0xb0, 91, 0]);
  await page.getByLabel('Button 2: released').waitFor();
  assert.equal(await page.locator('.mixer-details .pad.lit').count(), 16, 'track display returns after release');
  await page.getByRole('button', { name: 'Controller', exact: true }).click();
  await page.locator('#opz-out').selectOption('iac');
  assert.equal(await page.locator('#opz-out').inputValue(), 'opz', 'IAC and OP-Z outputs cannot be shared');
  async function screenshot(name) {
    if (!process.env.OPZ_PADS_SCREENSHOTS) return;
    await mkdir(process.env.OPZ_PADS_SCREENSHOTS, { recursive: true });
    await page.screenshot({ path: join(process.env.OPZ_PADS_SCREENSHOTS, `${name}.png`), fullPage: true });
  }

  await page.getByRole('button', { name: 'iRig check', exact: true }).click();
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
  assert.equal(await page.locator('.check-list button').count(), 6, 'all check sections are available');
  await selectCheck('Simultaneous holds');
  await emit('irig', [0x90, 60, 100]);
  await selectCheck('Controls and modifiers');
  await selectCheck('Simultaneous holds');
  assert.match(await page.locator('.irig-check').textContent(), /Press and hold pad 1/, 'interrupted hold restarts');
  for (const data of [[0x90, 60, 100], [0x91, 60, 100], [0x80, 60, 0], [0x81, 60, 0]]) await emit('irig', data);
  await checkComplete('Simultaneous holds', true);
  await selectCheck('Scene selection');
  await emit('irig', [0xb0, 90, 127]);
  await checkComplete('Scene selection', false);
  await checkComplete('Simultaneous holds', false);
  await emit('irig', [0xb1, 90, 1]);
  await checkComplete('Scene selection', false);
  await emit('irig', [0xb1, 90, 127]);
  await checkComplete('Scene selection', false);
  await emit('irig', [0xb1, 90, 0]);
  await checkComplete('Scene selection', true);
  await selectCheck('Pads and pressure');
  await emit('irig', [0xb0, 96, 64]);
  await page.getByText(/Different scene detected; checks reset/).waitFor();
  await checkComplete('Scene selection', false);
  await emit('irig', [0xb1, 91, 127]);
  await emit('irig', [0xb1, 91, 0]);
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
  for (const data of [[0xb1, 94, 64], [0xb1, 95, 64], [0xb1, 96, 64]]) await emit('irig', data);
  await page.getByText(/Move DATA clockwise.*channel 2, CC 92/).waitFor();
  await emit('irig', [0xb0, 7, 1]);
  assert.match(await page.locator('.irig-check').textContent(), /Move DATA clockwise.*CC 92/, 'old encoder CC is rejected');
  for (const data of [
    [0xb1, 92, 1], [0xb1, 92, 127],
    [0xb1, 90, 127], [0xb1, 90, 0], [0xb1, 91, 127], [0xb1, 91, 0],
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
    [0x90, 60, 100], [0xb1, 90, 127], [0xb1, 94, 65], [0xb1, 90, 0], [0x80, 60, 0],
    [0x90, 60, 100], [0xb1, 91, 127], [0xb1, 95, 65], [0xb1, 91, 0], [0x80, 60, 0],
    [0xb1, 93, 127], [0xb1, 92, 1], [0xb1, 92, 127], [0xb1, 93, 0],
  ]) await emit('irig', data);
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
  const ledCcs = [94, 96, 98, 100, 86, 88, 90, 92, 78, 80, 82, 84, 70, 72, 74, 76];
  const colors = [[0, 32], [0, 127], [32, 96], [64, 64], [96, 32], [127, 0], [32, 0], [0, 0]];
  const expected = ledCcs.flatMap((cc) => colors.flatMap(([red, green]) => [
    [0xb0, cc, green], [0xb0, cc + 1, red],
    [0xb0, 24, green], [0xb0, 25, red], [0xb0, 26, green], [0xb0, 27, red],
  ]));
  const messages = await sent('irig');
  assert.deepEqual(messages.slice(0, 32), ledCcs.flatMap((cc) => [[0xb0, cc, 0], [0xb0, cc + 1, 0]]), 'sequence clears all pads first');
  assert.deepEqual(messages.slice(32, 32 + expected.length), expected, 'every pad and button displays the full color and brightness sequence');
  assert.deepEqual(messages.slice(32 + expected.length, 38 + expected.length), [
    [0xb0, 76, 0], [0xb0, 77, 0], [0xb0, 24, 0], [0xb0, 25, 0], [0xb0, 26, 0], [0xb0, 27, 0],
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
  await page.getByRole('button', { name: 'Controller', exact: true }).click();
  assert.equal((await sent('irig')).length, 32, 'leaving the check restores the scene LEDs');
  assert.match(await page.locator('#message').textContent(), /synchronize after the check/);
  await page.locator('#opz-in').selectOption('opz');

  assert.equal(await page.locator('.controller .pad').count(), 16);
  await screenshot('controller');
  await page.getByRole('button', { name: 'Scenes', exact: true }).click();
  await page.locator('[data-scene-type="1"]').selectOption('drum');
  await screenshot('scenes');
  await clear();
  await emit('irig', [0xb1, 94, 64]);
  assert((await sent('irig')).some((m) => m[0] === 0xb0 && m[1] === 94), 'scene change reconciles pad LEDs');
  await emit('irig', [0x90, 60, 100]);
  await emit('opz', [0x91, 40, 100]);
  await page.getByRole('button', { name: 'Drum', exact: true }).click();
  assert.equal(await page.locator('.drum-card').first().getByText('UNASSIGNED').count(), 1, 'learning requires a known stopped transport');
  await emit('opz', [0xfc]);
  await emit('opz', [0x91, 40, 100]);
  await page.locator('.drum-card').first().getByText('SNARE').waitFor();
  assert.equal(await page.locator('.drum-card').first().getByText('SNARE').count(), 1);
  assert((await sent('irig')).some((m) => m[1] === 95 && m[2] === 127), 'snare LED red');
  await emit('irig', [0x80, 60, 0]);
  await clear();
  await emit('irig', [0x90, 60, 100]);
  assert((await sent('opz')).some((m) => m.join() === '145,40,100'), 'pad plays learned note');
  await emit('irig', [0xb1, 96, 90]);
  await page.locator('.drum-card').first().getByText('MAX VEL 90').waitFor();
  assert.match(await page.locator('.drum-card').first().textContent(), /MAX VEL 90/, 'first fader movement sets velocity');
  await emit('irig', [0xb1, 94, 64]);
  await emit('irig', [0xb1, 94, 66]);
  assert.equal((await sent('opz')).filter((m) => m.join() === '177,32,1').length, 2, 'pot sends relative pitch');
  await page.waitForTimeout(140);
  assert((await sent('opz')).filter((m) => m.join() === '145,40,90').length >= 2, 'moving a parameter repeats the note');
  await page.waitForTimeout(180);
  const countAfterStop = (await sent('opz')).length;
  await page.waitForTimeout(160);
  assert.equal((await sent('opz')).length, countAfterStop, 'audition stops after movement');
  await emit('irig', [0xb1, 90, 127]);
  await emit('irig', [0xb1, 91, 127]);
  await emit('irig', [0xb1, 95, 64]);
  await emit('irig', [0xb1, 95, 63]);
  assert((await sent('opz')).some((m) => m.join() === '177,37,127'), 'button 1 selects attack and excludes button 2');
  await emit('irig', [0x80, 60, 0]);
  assert((await sent('opz')).some((m) => m.join() === '129,40,0'), 'release sends note off');
  await screenshot('drum-kit');
  await emit('irig', [0x90, 60, 100]);
  await page.getByRole('button', { name: 'Controller', exact: true }).click();
  await screenshot('controller');
  await clear();
  await page.locator('#opz-out').selectOption('irig');
  assert((await sent('opz')).some((m) => m.join() === '129,40,0'), 'output change releases notes on the previous output');
  await page.locator('#opz-out').selectOption('opz');
  await emit('irig', [0x90, 60, 100]);
  await clear();
  await page.evaluate(() => window.mockMidi.setState('input', 'irig', 'disconnected'));
  await page.waitForFunction(() => document.querySelector('#message').textContent.includes('disconnected'));
  assert((await sent('opz')).some((m) => m.join() === '129,40,0'), 'input disconnect releases sounding notes');
  assert.equal(await page.locator('#irig-in').inputValue(), '', 'disconnected input is cleared');
  await page.evaluate(() => window.mockMidi.setState('input', 'irig', 'connected'));
  await page.waitForFunction(() => document.querySelector('#irig-in').value === 'irig');
  await emit('irig', [0x90, 60, 100]);
  await clear();
  await emit('irig', [0xb0, 90, 127]);
  assert((await sent('opz')).some((m) => m.join() === '129,40,0'), 'scene change releases sounding notes');
  await emit('opz', [0xb1, 5, 75]);
  await page.getByRole('button', { name: 'Diagnostics', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Channel 2 CC 5' }).textContent(), '75');
  await page.getByRole('button', { name: 'Channel 2 CC 5' }).click();
  assert.match(await page.locator('.diagnostics').textContent(), /1 recent messages/);
  await screenshot('diagnostics');
  await page.reload();
  await page.getByRole('button', { name: 'Scenes', exact: true }).click();
  assert.equal(await page.locator('[data-scene-type="1"]').inputValue(), 'drum', 'project persists after reload');
  const project = JSON.parse(await page.evaluate(() => localStorage.getItem('opz-pads-project-v1')));
  assert.deepEqual(project.scenes[1].pads[0], { channel: 1, note: 40, velocity: 90 });
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.locator('[data-scene-type="1"]').selectOption('empty');
  assert.equal(await page.locator('[data-scene-type="1"]').inputValue(), 'drum', 'cancel keeps the scene type');
  await page.locator('#import').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{"version":1,"scenes":[]}') });
  await page.waitForFunction(() => document.querySelector('#message').textContent.includes('Invalid or unsupported'));
  assert.match(await page.locator('#message').textContent(), /Invalid or unsupported/);
  project.scenes[1].pads[0].velocity = 45;
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#import').setInputFiles({ name: 'project.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(project)) });
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('opz-pads-project-v1')).scenes[1].pads[0].velocity === 45);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download project' }).click();
  const download = await downloadPromise;
  assert.equal(download.suggestedFilename(), 'opz-pads-project.json');
  const chunks = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk);
  assert.equal(JSON.parse(Buffer.concat(chunks).toString()).scenes[1].pads[0].velocity, 45);
  assert.deepEqual(errors, []);
  console.log('OP-Z Pads mocked MIDI workflow passed.');
} finally {
  await browser.close();
}
