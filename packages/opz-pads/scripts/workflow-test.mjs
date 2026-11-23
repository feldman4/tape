import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const url = process.env.OPZ_PADS_URL ?? 'http://localhost:5173/tape/opz-pads/';
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1536, height: 1024 }, acceptDownloads: true });
await context.addInitScript(() => {
  const inputs = new Map(['irig', 'opz'].map((name) => [name, { id: name, name, state: 'connected', onmidimessage: null }]));
  const outputs = new Map(['irig', 'opz'].map((name) => [name, {
    id: name, name, state: 'connected', sent: [], send(data) { this.sent.push([...data]); },
  }]));
  const access = { inputs, outputs, onstatechange: null };
  window.mockMidi = {
    inputs, outputs,
    emit(port, data) { inputs.get(port).onmidimessage?.({ data: new Uint8Array(data) }); },
    setState(direction, port, state) {
      (direction === 'input' ? inputs : outputs).get(port).state = state;
      access.onstatechange?.();
    },
  };
  Object.defineProperty(navigator, 'requestMIDIAccess', { configurable: true, value: async () => access });
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
  await page.getByRole('button', { name: 'Enable MIDI' }).click();
  for (const [id, value] of [['irig-in', 'irig'], ['irig-out', 'irig'], ['opz-in', 'opz'], ['opz-out', 'opz']]) {
    await page.locator(`#${id}`).selectOption(value);
  }
  for (const tab of ['Scenes', 'Drum', 'Diagnostics']) {
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
  async function screenshot(name) {
    if (!process.env.OPZ_PADS_SCREENSHOTS) return;
    await mkdir(process.env.OPZ_PADS_SCREENSHOTS, { recursive: true });
    await page.screenshot({ path: join(process.env.OPZ_PADS_SCREENSHOTS, `${name}.png`), fullPage: true });
  }

  assert.equal(await page.locator('.controller .pad').count(), 16);
  await screenshot('controller');
  await page.getByRole('button', { name: 'Scenes', exact: true }).click();
  await page.locator('[data-scene-type="1"]').selectOption('drum');
  await screenshot('scenes');
  await clear();
  await emit('irig', [0xc0, 1]);
  assert((await sent('irig')).some((m) => m[0] === 0xb0 && m[1] === 94), 'scene change reconciles pad LEDs');
  await emit('irig', [0x90, 48, 100]);
  await emit('opz', [0x91, 40, 100]);
  await page.getByRole('button', { name: 'Drum', exact: true }).click();
  assert.equal(await page.locator('.drum-card').first().getByText('UNASSIGNED').count(), 1, 'learning requires a known stopped transport');
  await emit('opz', [0xfc]);
  await emit('opz', [0x91, 40, 100]);
  await page.locator('.drum-card').first().getByText('SNARE').waitFor();
  assert.equal(await page.locator('.drum-card').first().getByText('SNARE').count(), 1);
  assert((await sent('irig')).some((m) => m[1] === 95 && m[2] === 127), 'snare LED red');
  await emit('irig', [0x80, 48, 0]);
  await clear();
  await emit('irig', [0x90, 48, 100]);
  assert((await sent('opz')).some((m) => m.join() === '145,40,100'), 'pad plays learned note');
  await emit('irig', [0xb0, 1, 90]);
  await page.locator('.drum-card').first().getByText('MAX VEL 90').waitFor();
  assert.match(await page.locator('.drum-card').first().textContent(), /MAX VEL 90/, 'first fader movement sets velocity');
  await emit('irig', [0xb0, 10, 64]);
  await emit('irig', [0xb0, 10, 66]);
  assert.equal((await sent('opz')).filter((m) => m.join() === '177,32,1').length, 2, 'pot sends relative pitch');
  await page.waitForTimeout(140);
  assert((await sent('opz')).filter((m) => m.join() === '145,40,90').length >= 2, 'moving a parameter repeats the note');
  await page.waitForTimeout(180);
  const countAfterStop = (await sent('opz')).length;
  await page.waitForTimeout(160);
  assert.equal((await sent('opz')).length, countAfterStop, 'audition stops after movement');
  await emit('irig', [0xb0, 20, 127]);
  await emit('irig', [0xb0, 21, 127]);
  await emit('irig', [0xb0, 11, 64]);
  await emit('irig', [0xb0, 11, 63]);
  assert((await sent('opz')).some((m) => m.join() === '177,37,127'), 'button 1 selects attack and excludes button 2');
  await emit('irig', [0x80, 48, 0]);
  assert((await sent('opz')).some((m) => m.join() === '129,40,0'), 'release sends note off');
  await screenshot('drum-kit');
  await emit('irig', [0x90, 48, 100]);
  await page.getByRole('button', { name: 'Controller', exact: true }).click();
  await screenshot('controller');
  await clear();
  await page.locator('#opz-out').selectOption('irig');
  assert((await sent('opz')).some((m) => m.join() === '129,40,0'), 'output change releases notes on the previous output');
  await page.locator('#opz-out').selectOption('opz');
  await emit('irig', [0x90, 48, 100]);
  await clear();
  await page.evaluate(() => window.mockMidi.setState('input', 'irig', 'disconnected'));
  await page.waitForFunction(() => document.querySelector('#message').textContent.includes('disconnected'));
  assert((await sent('opz')).some((m) => m.join() === '129,40,0'), 'input disconnect releases sounding notes');
  assert.equal(await page.locator('#irig-in').inputValue(), '', 'disconnected input is cleared');
  await page.evaluate(() => window.mockMidi.setState('input', 'irig', 'connected'));
  await page.locator('#irig-in').selectOption('irig');
  await emit('irig', [0x90, 48, 100]);
  await clear();
  await emit('irig', [0xc0, 0]);
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
