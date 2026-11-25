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
  engine.irig([0xb1, 90, 127]);
  engine.irig([0xb1, 90, 0]);
  return { engine, sent, saved };
}

test('MIDI decoding normalizes note-off and rejects incomplete or unrelated messages', () => {
  assert.deepEqual(decodeMidi([0x92, 60, 0]), { type: 'note', channel: 2, note: 60, velocity: 0, on: false });
  assert.equal(decodeMidi([0x90, 60]), null);
  assert.equal(decodeMidi([0xb0, 10]), null);
  assert.deepEqual(decodeMidi([0xfb]), { type: 'transport', state: 'running' });
  assert.equal(decodeIrig([0xc3, 15]), null);
  assert.equal(decodeIrig([0xb1, 20, 127]), null);
  for (const cc of [1, 7, 10, 11, 22]) assert.equal(decodeIrig([0xb0, cc, 127]), null);
  for (const cc of [94, 95, 96]) {
    assert.deepEqual(decodeIrig([0xb1, cc, 64]), { type: 'control', control: cc, value: 64, scene: 1 });
  }
  assert.deepEqual(decodeIrig([0xbf, 92, 1]), { type: 'control', control: 92, value: 1, scene: 15 });
  assert.deepEqual(decodeIrig([0xbf, 93, 127]), { type: 'push', pressed: true, scene: 15 });
  assert.deepEqual(decodeIrig([0xbf, 93, 0]), { type: 'push', pressed: false, scene: 15 });
  assert.equal(decodeIrig([0xb0, 93, 1]), null);
  assert.equal(decodeIrig([0x90, 48, 100]), null);
  assert.deepEqual(decodeIrig([0x90, 60, 100]), { type: 'pad', index: 0, on: true, velocity: 100 });
  for (let channel = 0; channel < 16; channel++) {
    assert.deepEqual(decodeIrig([0xb0 + channel, 90, 127]), { type: 'button', index: 0, pressed: true, scene: channel });
    assert.deepEqual(decodeIrig([0xb0 + channel, 91, 0]), { type: 'button', index: 1, pressed: false, scene: channel });
    for (const cc of [92, 94, 95, 96]) {
      assert.deepEqual(decodeIrig([0xb0 + channel, cc, 1]), { type: 'control', control: cc, value: 1, scene: channel });
    }
    assert.deepEqual(decodeIrig([0xb0 + channel, 93, 127]), { type: 'push', pressed: true, scene: channel });
    assert.equal(decodeIrig([0xb0 + channel, 90, 1]), null);
  }
  assert.deepEqual(decodeIrig([0xd5, 75]), { type: 'pressure', index: 5, value: 75 });
});

test('controller gesture state preserves exclusive modifiers and control baselines', () => {
  const controller = new ControllerState();
  controller.button(0, true);
  controller.button(1, true);
  assert.deepEqual(controller.buttons, [true, false]);
  controller.button(0, false);
  assert.deepEqual(controller.buttons, [false, false]);
  assert.equal(controller.move(94, 64), 0);
  assert.equal(controller.move(94, 67), 3);
  assert.equal(controller.move(92, 127), -1);
  controller.resetControls();
  assert.equal(controller.move(94, 70), 0);
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
  inputs.get('irig').onmidimessage({ data: Uint8Array.from([0x90, 60, 100]), timeStamp: 10 });
  inputs.get('opz').onmidimessage({ data: Uint8Array.from([0xfc]), timeStamp: 20 });
  assert.deepEqual(received, [['irig', 0x90, 60, 100], ['opz', 0xfc]]);
  assert.equal(devices.send('opz', [0x90, 40, 100]), true);
  assert.equal(devices.send('missing', [0x90, 40, 100]), false);
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
  engine.irig([0x90, 60, 50], 11);
  engine.irig([0xd0, 70], 12);
  engine.irig([0xb1, 94, 64], 13);
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
  engine.irig([0x90, 60, 100]);
  engine.opz([0x91, 40, 100]);
  assert.equal(engine.project.scenes[1].pads[0], null);
  engine.opz([0xfc]);
  engine.opz([0x91, 40, 100]);
  assert.deepEqual(engine.project.scenes[1].pads[0], { channel: 1, note: 40, velocity: 127 });
  assert.deepEqual(saved.at(-1).scenes[1].pads[0], { channel: 1, note: 40, velocity: 127 });
  engine.irig([0x80, 60, 0]);
  engine.irig([0x90, 60, 100]);
  assert(sent.some(({ destination, bytes }) => destination === 'opz' && bytes.join() === '145,40,100'));
  sent.length = 0;
  engine.irig([0xb0, 91, 127]);
  assert(sent.some(({ destination, bytes }) => destination === 'opz' && bytes.join() === '129,40,0'));
  assert(sent.filter(({ destination }) => destination === 'irig').length >= 32, 'scene detection refreshes all LEDs');
  assert.equal(engine.held[0], false);
  assert.equal(engine.scene, 0);
  assert.deepEqual(engine.buttons, [false, true], 'scene-changing button press is applied to the new scene');
  engine.irig([0xbf, 90, 0]);
  assert.equal(engine.scene, 15, 'a button release also identifies its scene');
  assert.deepEqual(engine.buttons, [false, false], 'scene change clears old modifiers');
  engine.irig([0xc0, 0]);
  assert.equal(engine.scene, 15, 'program changes do not switch scenes');
});

test('scene-specific controls switch scenes and process the triggering message', () => {
  for (const [cc, value, type] of [[92, 1, 'control'], [93, 127, 'push'], [93, 0, 'push'],
    [94, 64, 'control'], [95, 64, 'control'], [96, 64, 'control']]) {
    const { engine, sent } = setup();
    engine.opz([0xfc]);
    engine.irig([0x90, 60, 100]);
    engine.opz([0x91, 40, 100]);
    engine.irig([0x80, 60, 0]);
    engine.irig([0x90, 60, 100]);
    const events = [];
    engine.handlers.empty = {
      leds: () => Array.from({ length: 16 }, () => [0, 0]),
      handle: (_scene, _controller, event) => events.push(event),
      release: () => {},
    };
    sent.length = 0;
    engine.irig([0xbf, cc, value], 100);
    assert.equal(engine.scene, 15, `CC ${cc} identifies scene 16`);
    assert(sent.some(({ destination, bytes }) => destination === 'opz' && bytes.join() === '129,40,0'), 'old scene note is released');
    assert(sent.filter(({ destination }) => destination === 'irig').length >= 32, 'scene switch refreshes LEDs');
    assert.equal(events.length, 1);
    assert.equal(events[0].type, type);
    assert.equal(events[0].scene, 15);
    assert.equal(events[0].time, 100);
    if (cc === 92) assert.equal(events[0].delta, 1, 'relative turn is applied immediately');
    if (cc === 94 || cc === 95 || cc === 96) assert.equal(events[0].delta, 0, 'absolute control starts a fresh baseline');
    if (cc === 93) assert.equal(engine.push, value === 127);
    if (cc === 96) assert.equal(engine.fader, value);
  }
});

test('drum controls adjust a channel once for multiple held pads and cancel auditions on release', async () => {
  const { engine, sent } = setup();
  engine.opz([0xfc]);
  engine.irig([0x90, 60, 100]);
  engine.irig([0x91, 60, 100]);
  engine.opz([0x91, 40, 100]);
  engine.irig([0xb1, 94, 64]);
  sent.length = 0;
  engine.irig([0xb1, 94, 66]);
  assert.equal(sent.filter(({ destination, bytes }) => destination === 'opz' && bytes.join() === '177,32,1').length, 2);
  engine.releaseAll();
  const count = sent.length;
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(sent.length, count);
});

test('DATA CC 92 adjusts relative parameters and CC 93 selects push-turn', () => {
  const { engine, sent } = setup();
  engine.opz([0xfc]);
  engine.irig([0x90, 60, 100]);
  engine.opz([0x91, 40, 100]);
  sent.length = 0;
  engine.irig([0xb1, 92, 1]);
  engine.irig([0xb1, 92, 127]);
  engine.irig([0xb1, 93, 127]);
  engine.irig([0xb1, 92, 1]);
  engine.irig([0xb1, 93, 0]);
  engine.irig([0xb1, 92, 1]);
  assert.deepEqual(sent.filter(({ destination, bytes }) => destination === 'opz' && bytes[0] === 0xb1)
    .map(({ bytes }) => bytes), [[0xb1, 34, 1], [0xb1, 34, 127], [0xb1, 35, 1], [0xb1, 34, 1]]);
  engine.releaseAll();
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
  engine.irig([0x90, 60, 100]);
  engine.opz([0x90, 40, 100]);
  engine.irig([0x80, 60, 0]);
  engine.irig([0x90, 60, 100]);
  sent.length = 0;
  engine.setType(1, 'empty');
  assert(sent.some(({ destination, bytes }) => destination === 'opz' && bytes.join() === '128,40,0'));
  assert.equal(engine.held[0], false);
  assert.equal(engine.project.scenes[1].type, 'empty');
});
