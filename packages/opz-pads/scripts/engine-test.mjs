import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeIrig, decodeMidi } from '../src/midi.ts';
import { ControllerState } from '../src/controller.ts';
import { MidiDevices } from '../src/devices.ts';
import { Engine, newProject, validateProject } from '../src/engine.ts';

function setup() {
  const sent = [];
  const saved = [];
  const engine = new Engine({
    send: (destination, bytes) => sent.push({ destination, bytes }),
    changed: () => {},
    save: (project) => saved.push(structuredClone(project)),
  });
  engine.setType(1, 'drum');
  engine.irig([0xc0, 1]);
  return { engine, sent, saved };
}

test('MIDI decoding normalizes note-off and rejects incomplete or unrelated messages', () => {
  assert.deepEqual(decodeMidi([0x92, 48, 0]), { type: 'note', channel: 2, note: 48, velocity: 0, on: false });
  assert.equal(decodeMidi([0x90, 48]), null);
  assert.equal(decodeMidi([0xb0, 10]), null);
  assert.deepEqual(decodeMidi([0xfb]), { type: 'transport', state: 'running' });
  assert.deepEqual(decodeIrig([0xc3, 15]), { type: 'scene', index: 15 });
  assert.equal(decodeIrig([0xc0, 16]), null);
  assert.equal(decodeIrig([0xb1, 20, 127]), null);
  assert.deepEqual(decodeIrig([0xd5, 75]), { type: 'pressure', index: 5, value: 75 });
});

test('controller gesture state preserves exclusive modifiers and control baselines', () => {
  const controller = new ControllerState();
  controller.button(0, true);
  controller.button(1, true);
  assert.deepEqual(controller.buttons, [true, false]);
  controller.button(0, false);
  assert.deepEqual(controller.buttons, [false, false]);
  assert.equal(controller.move(10, 64), 0);
  assert.equal(controller.move(10, 67), 3);
  assert.equal(controller.move(7, 127), -1);
  controller.resetControls();
  assert.equal(controller.move(10, 70), 0);
});

test('device adapter routes selected inputs, rejects duplicate inputs, and sends to the requested output', () => {
  const inputs = new Map(['irig', 'opz'].map((id) => [id, { id, name: id, state: 'connected', onmidimessage: null }]));
  const sent = [];
  const outputs = new Map([['opz', { id: 'opz', name: 'opz', state: 'connected', send: (bytes) => sent.push(bytes) }]]);
  const access = { inputs, outputs, onstatechange: null };
  const devices = new MidiDevices(access);
  const received = [];
  assert.equal(devices.configureInputs('irig', 'opz', (bytes) => received.push(['irig', ...bytes]),
    (bytes) => received.push(['opz', ...bytes])), true);
  inputs.get('irig').onmidimessage({ data: Uint8Array.from([0x90, 48, 100]), timeStamp: 10 });
  inputs.get('opz').onmidimessage({ data: Uint8Array.from([0xfc]), timeStamp: 20 });
  assert.deepEqual(received, [['irig', 0x90, 48, 100], ['opz', 0xfc]]);
  devices.send('opz', [0x90, 40, 100]);
  assert.deepEqual(sent, [[0x90, 40, 100]]);
  assert.equal(devices.configureInputs('irig', 'irig', () => {}, () => {}), false);
  assert.equal(inputs.get('irig').onmidimessage, null);
  assert.equal(inputs.get('opz').onmidimessage, null);
  devices.configureInputs('irig', 'opz', () => {}, () => {});
  devices.onStateChange(() => {});
  devices.dispose();
  assert.equal(inputs.get('irig').onmidimessage, null);
  assert.equal(inputs.get('opz').onmidimessage, null);
  assert.equal(access.onstatechange, null);
});

test('scene events combine timestamped controller and OP-Z input and refresh pressure LEDs', () => {
  const { engine, sent } = setup();
  const events = [];
  engine.handlers.drum = {
    leds: (_scene, controller) => Array.from({ length: 16 }, (_, index) =>
      [controller.pressure[index], 0]),
    handle: (_scene, controller, event) => events.push({ event, pressure: controller.pressure[0] }),
    release: () => {},
  };
  engine.refreshLeds();
  sent.length = 0;
  engine.irig([0xd0, 30], 10);
  assert.equal(events.length, 0, 'unheld pads ignore pressure');
  engine.irig([0x90, 48, 50], 11);
  engine.irig([0xd0, 70], 12);
  engine.irig([0xb0, 10, 64], 13);
  engine.opz([0xb1, 5, 75], 14);
  engine.opz([0xfc], 15);
  assert.deepEqual(events.map(({ event }) => [event.type, event.time]), [
    ['pad', 11], ['pressure', 12], ['control', 13], ['midi', 14], ['midi', 15],
  ]);
  assert.equal(events[1].pressure, 70, 'controller state is updated before dispatch');
  assert.equal(events[4].event.transport, 'stopped');
  assert.deepEqual(sent.filter(({ destination }) => destination === 'irig').map(({ bytes }) => bytes), [
    [0xb0, 95, 50], [0xb0, 95, 70],
  ], 'only changed LED components are sent');
  sent.length = 0;
  engine.refreshLeds();
  assert.equal(sent.filter(({ destination }) => destination === 'irig').length, 32, 'explicit refresh reconciles all LEDs');
});

test('device adapter preserves MIDI event timestamps', () => {
  const input = { id: 'irig', state: 'connected', onmidimessage: null };
  const devices = new MidiDevices({ inputs: new Map([['irig', input]]), outputs: new Map() });
  const received = [];
  devices.configureInputs('irig', '', (bytes, time) => received.push([Array.from(bytes), time]), () => {});
  input.onmidimessage({ data: Uint8Array.from([0xd0, 64]), timeStamp: 123.5 });
  assert.deepEqual(received, [[[0xd0, 64], 123.5]]);
});

test('learning requires stopped transport and scene changes release notes', () => {
  const { engine, sent, saved } = setup();
  engine.irig([0x90, 48, 100]);
  engine.opz([0x91, 40, 100]);
  assert.equal(engine.project.scenes[1].pads[0], null);
  engine.opz([0xfc]);
  engine.opz([0x91, 40, 100]);
  assert.deepEqual(engine.project.scenes[1].pads[0], { channel: 1, note: 40, velocity: 127 });
  assert.deepEqual(saved.at(-1).scenes[1].pads[0], { channel: 1, note: 40, velocity: 127 });
  engine.irig([0x80, 48, 0]);
  engine.irig([0x90, 48, 100]);
  assert(sent.some(({ destination, bytes }) => destination === 'opz' && bytes.join() === '145,40,100'));
  engine.irig([0xc0, 0]);
  assert(sent.some(({ destination, bytes }) => destination === 'opz' && bytes.join() === '129,40,0'));
  assert.equal(engine.held[0], false);
});

test('drum controls adjust a channel once for multiple held pads and cancel auditions on release', async () => {
  const { engine, sent } = setup();
  engine.opz([0xfc]);
  engine.irig([0x90, 48, 100]);
  engine.irig([0x91, 48, 100]);
  engine.opz([0x91, 40, 100]);
  engine.irig([0xb0, 10, 64]);
  sent.length = 0;
  engine.irig([0xb0, 10, 66]);
  assert.equal(sent.filter(({ destination, bytes }) => destination === 'opz' && bytes.join() === '177,32,1').length, 2);
  engine.releaseAll();
  const count = sent.length;
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(sent.length, count);
});

test('project validation checks scene and pad invariants', () => {
  const project = newProject();
  assert.equal(validateProject(project), true);
  project.scenes[1] = { type: 'drum', pads: Array(16).fill(null) };
  project.scenes[1].pads[0] = { channel: 4, note: 40, velocity: 127 };
  assert.equal(validateProject(project), false);
  assert.throws(() => setup().engine.setProject(project), /Invalid or unsupported/);
});

test('replacing the active drum scene releases its playing notes', () => {
  const { engine, sent } = setup();
  engine.opz([0xfc]);
  engine.irig([0x90, 48, 100]);
  engine.opz([0x90, 40, 100]);
  engine.irig([0x80, 48, 0]);
  engine.irig([0x90, 48, 100]);
  sent.length = 0;
  engine.setType(1, 'empty');
  assert(sent.some(({ destination, bytes }) => destination === 'opz' && bytes.join() === '128,40,0'));
  assert.equal(engine.held[0], false);
  assert.equal(engine.project.scenes[1].type, 'empty');
});
