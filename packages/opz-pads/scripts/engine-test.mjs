import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeIrig, decodeMidi } from '../src/midi/midi.ts';
import { ControllerState } from '../src/engine/controller.ts';
import { MidiDevices } from '../src/midi/devices.ts';
import { Engine, newProject, validateProject } from '../src/engine/engine.ts';
import { flipPadIndex, IRIG_MIDI } from '../src/irig/midi.ts';
import { padLedMessages } from '../src/irig/leds.ts';
import { parseKitFile, parseProjectFile } from '../src/project/storage.ts';

function appIrig(engine, bytes, time) {
  const [status, ...data] = bytes;
  const kind = status & 0xf0;
  const mapped = kind === 0x80 || kind === 0x90 || kind === 0xd0 ||
    (kind === 0xb0 && data[0] === IRIG_MIDI.cc.fader);
  engine.irig([mapped ? kind + flipPadIndex(status & 15) : status, ...data], time);
}

test('iRig boundaries map physical channels to top-left-first app pads and scenes', () => {
  for (let device = 0; device < 16; device++) {
    const app = flipPadIndex(device);
    assert.equal(flipPadIndex(app), device);
    assert.equal(decodeIrig([0x90 + device, 60, 100]).index, app);
    assert.equal(decodeIrig([0xd0 + device, 42]).index, app);
    assert.equal(decodeIrig([0xb0 + device, 96, 42]).scene, app);
    assert.equal(padLedMessages(app, [2, 3])[0][1], IRIG_MIDI.padGreenLedCCs[device]);
  }
  assert.equal(flipPadIndex(12), 0);
  assert.equal(flipPadIndex(0), 12);
});

function fxSetup(pads = [], a = null, b = null) {
  const sent = [];
  const saved = [];
  const engine = new Engine({ send: (destination, bytes) => { sent.push({ destination, bytes }); return true; },
    changed: () => {}, save: (project) => saved.push(structuredClone(project)) });
  const project = newProject();
  project.scenes[1] = { type: 'fx', pads: Array.from({ length: 16 }, (_, index) => pads[index] ?? null), a, b };
  engine.setProject(project);
  engine.selectScene(1);
  return { engine, sent, saved };
}

test('FX learns notes while stopped and toggles an offset with a bidirectional gesture', () => {
  const { engine, sent, saved } = fxSetup();
  appIrig(engine, [0x90, 60, 100]);
  engine.opz([0x92, 48, 100], 0);
  assert.equal(engine.project.scenes[1].pads[0], null);
  engine.opz([0xfc]);
  engine.opz([0x92, 48, 100], 1);
  assert.deepEqual(engine.project.scenes[1].pads[0], { type: 'note', channel: 2, note: 48 });
  appIrig(engine, [0x80, 60, 0]);
  appIrig(engine, [0x90, 60, 100]);
  engine.opz([0xb2, 3, 60], 10);
  engine.opz([0xb2, 3, 70], 20);
  engine.opz([0xb2, 3, 65], 30);
  assert.deepEqual(engine.project.scenes[1].pads[0], { type: 'scene', offsets: [{ channel: 2, cc: 3, offset: 0 }] });
  assert(sent.some(({ destination, bytes }) => destination === 'opz' && bytes[0] === 0x82 && bytes[1] === 48));
  appIrig(engine, [0xb1, 92, 10]);
  assert.equal(engine.outputValues[2][2], 75, 'editing applies at full depth');
  appIrig(engine, [0xb1, 93, 127]);
  appIrig(engine, [0xb1, 93, 0]);
  appIrig(engine, [0xd0, 0]);
  assert.equal(engine.outputValues[2][2], 65, 'pressure controls the finalized scene');
  engine.opz([0xb2, 3, 60], 40);
  engine.opz([0xb2, 3, 70], 50);
  engine.opz([0xb2, 3, 65], 60);
  assert.deepEqual(engine.project.scenes[1].pads[0].offsets, []);
  assert(saved.length >= 3);
  engine.releaseAll();
  engine.cancelReleaseLedRefreshes();
});

test('FX crossfades offsets, blends the latest held scene, restores bases and waits for unknown values', () => {
  const { engine, sent } = fxSetup([
    { type: 'scene', offsets: [{ channel: 0, cc: 1, offset: 40 }, { channel: 0, cc: 2, offset: 20 }] },
    { type: 'scene', offsets: [{ channel: 0, cc: 1, offset: -20 }] },
  ], 0, 1);
  assert.equal(sent.filter(({ destination }) => destination === 'iac').length, 0, 'unknown base is not guessed');
  engine.opz([0xb0, 1, 100]);
  assert.equal(engine.outputValues[0][0], 80);
  appIrig(engine, [0xb1, 96, 0]);
  assert.equal(engine.outputValues[0][0], 127, 'offset clamps at 127');
  assert.equal(engine.outputValues[0][1], null);
  engine.opz([0xb0, 2, 50]);
  assert.equal(engine.outputValues[0][1], 70);
  appIrig(engine, [0xb1, 96, 64]);
  assert.equal(engine.outputValues[0][0], 110);
  assert.equal(engine.outputValues[0][1], 60);
  appIrig(engine, [0x91, 60, 127]);
  assert.equal(engine.outputValues[0][0], 80);
  appIrig(engine, [0x90, 60, 127]);
  assert.equal(engine.outputValues[0][0], 127);
  appIrig(engine, [0x80, 60, 0]);
  assert.equal(engine.outputValues[0][0], 80);
  appIrig(engine, [0x81, 60, 0]);
  assert.equal(engine.outputValues[0][0], 110);
  engine.selectScene(0);
  assert.equal(engine.outputValues[0][0], 100);
  assert.equal(engine.outputValues[0][1], 50);
  assert.equal(sent.filter(({ destination, bytes }) => destination === 'opz' && (bytes[0] & 0xf0) === 0xb0).length, 0);
  engine.cancelReleaseLedRefreshes();
});

test('FX base follows successful OP-Z commands but diagnostics retain the observed input', () => {
  for (const succeeds of [true, false]) {
    const sent = [];
    const engine = new Engine({
      send: (destination, bytes) => {
        sent.push({ destination, bytes });
        return destination !== 'opz' || succeeds;
      },
      changed: () => {}, save: () => {},
    });
    const project = newProject();
    project.scenes[1] = { type: 'fx', pads: Array(16).fill(null), a: null, b: null };
    project.scenes[1].pads[0] = { type: 'scene', offsets: [{ channel: 0, cc: 16, offset: 20 }] };
    engine.setProject(project);
    engine.opz([0xb0, 16, 40]);
    appIrig(engine, [0x90, 60, 127]);
    appIrig(engine, [0xb0, 94, 80]);
    assert.equal(engine.values[0][15], 40);
    engine.selectScene(1);
    appIrig(engine, [0x90, 60, 127]);
    assert.equal(sent.filter(({ destination, bytes }) => destination === 'iac' && bytes[0] === 0xb0 && bytes[1] === 16).at(-1).bytes[2],
      succeeds ? 100 : 60);
    engine.selectScene(0);
    assert.equal(sent.filter(({ destination, bytes }) => destination === 'iac' && bytes[0] === 0xb0 && bytes[1] === 16).at(-1).bytes[2],
      succeeds ? 80 : 40);
    engine.cancelReleaseLedRefreshes();
  }
});

test('entering and leaving the iRig check releases notes and preserves pot positions', () => {
  const { engine, sent } = fxSetup([{ type: 'note', channel: 0, note: 60 }]);
  const check = new ControllerState();
  appIrig(engine, [0xb0, 94, 25]);
  appIrig(engine, [0x90, 60, 100]);
  engine.opz([0xfa]);
  engine.enterCheckMode(check);
  assert(sent.some(({ destination, bytes }) => destination === 'opz' && bytes.join() === '128,60,0'));
  assert.equal(engine.transport, 'unknown');
  assert.equal(check.pots[0], 25);
  check.move(IRIG_MIDI.cc.pot1, 80);
  engine.exitCheckMode(check);
  assert.equal(engine.pots[0], 80);
  assert.equal(engine.held[0], false);
  engine.cancelReleaseLedRefreshes();
});

test('project and kit files reject the removed v1 format', () => {
  const project = newProject();
  const kit = { type: 'drum', pads: Array(16).fill(null) };
  assert.equal(parseProjectFile(project), project);
  assert.equal(parseKitFile({ version: 2, kit }), kit);
  assert.throws(() => parseProjectFile({ ...project, version: 1 }), /Invalid or unsupported/);
  assert.throws(() => parseKitFile({ version: 1, kit }), /Invalid or unsupported/);
});

test('FX custom slots send pressure values only to Ableton and restore observed values', () => {
  const { engine, sent } = fxSetup();
  const slots = structuredClone(engine.customSlots);
  slots[0] = { channel: 4, cc: 70, min: 100, max: 20 };
  engine.setCustomSlots(slots);
  engine.opz([0xb4, 70, 50]);
  appIrig(engine, [0x90, 60, 100]);
  appIrig(engine, [0xb1, 93, 127]);
  appIrig(engine, [0xb1, 92, 1]);
  appIrig(engine, [0xb1, 93, 0]);
  assert.deepEqual(engine.project.scenes[1].pads[0], { type: 'custom', slot: 0 });
  appIrig(engine, [0xd0, 0]);
  assert.deepEqual(sent.filter(({ destination, bytes }) => destination === 'iac' && bytes[0] === 0xb4).at(-1).bytes, [0xb4, 70, 100]);
  appIrig(engine, [0xd0, 127]);
  assert.deepEqual(sent.filter(({ destination, bytes }) => destination === 'iac' && bytes[0] === 0xb4).at(-1).bytes, [0xb4, 70, 20]);
  appIrig(engine, [0x80, 60, 0]);
  assert.deepEqual(sent.filter(({ destination, bytes }) => destination === 'iac' && bytes[0] === 0xb4).at(-1).bytes, [0xb4, 70, 50]);
  assert.equal(sent.filter(({ destination, bytes }) => destination === 'opz' && bytes[0] === 0xb4).length, 0);
  assert.throws(() => engine.setCustomSlots([]), /Invalid/);
  engine.cancelReleaseLedRefreshes();
});

test('FX assigns and clears crossfade sides and custom pads override scene values', () => {
  const { engine, sent } = fxSetup([
    { type: 'scene', offsets: [{ channel: 0, cc: 1, offset: 20 }] },
    { type: 'custom', slot: 0 },
  ]);
  const slots = structuredClone(engine.customSlots);
  slots[0] = { channel: 0, cc: 1, min: 0, max: 127 };
  engine.setCustomSlots(slots);
  engine.opz([0xb0, 1, 50]);
  appIrig(engine, [0xb1, 95, 30]);
  appIrig(engine, [0x90, 60, 127]);
  appIrig(engine, [0xb1, 95, 15]);
  appIrig(engine, [0x80, 60, 0]);
  appIrig(engine, [0xb1, 96, 0]);
  assert.equal(engine.project.scenes[1].a, 0);
  assert.equal(engine.outputValues[0][0], 70);
  appIrig(engine, [0x91, 60, 127]);
  assert.equal(engine.outputValues[0][0], 127);
  appIrig(engine, [0x81, 60, 0]);
  assert.equal(engine.outputValues[0][0], 70);
  appIrig(engine, [0xb1, 95, 0]);
  assert.equal(engine.project.scenes[1].a, null);
  assert.equal(engine.outputValues[0][0], 50);
  assert.equal(sent.filter(({ destination, bytes }) => destination === 'opz' && (bytes[0] & 0xf0) === 0xb0).length, 0);
  engine.cancelReleaseLedRefreshes();
});

test('FX pot 2 requires 15 continuous steps in the selected direction and resets at pad changes', () => {
  const { engine, saved } = fxSetup([
    { type: 'scene', offsets: [] }, { type: 'scene', offsets: [] },
  ]);
  const scene = engine.project.scenes[1];
  appIrig(engine, [0x90, 60, 100]);
  appIrig(engine, [0xb1, 95, 100]);
  assert.equal(scene.a, null, 'first unknown position is only a baseline');
  appIrig(engine, [0xb1, 95, 93]);
  appIrig(engine, [0xb1, 95, 86]);
  assert.equal(scene.a, null, '14 steps are insufficient');
  appIrig(engine, [0xb1, 95, 85]);
  assert.equal(scene.a, 0, '15 leftward steps assign A even above the midpoint');
  appIrig(engine, [0xb1, 95, 95]);
  appIrig(engine, [0xb1, 95, 88]);
  appIrig(engine, [0xb1, 95, 100]);
  assert.equal(scene.b, null, 'reversal resets accumulated motion');
  appIrig(engine, [0xb1, 95, 103]);
  assert.equal(scene.b, 0, '15 rightward steps assign B');
  appIrig(engine, [0xb1, 95, 110]);
  appIrig(engine, [0x91, 60, 100]);
  appIrig(engine, [0xb1, 95, 117]);
  assert.equal(scene.b, 0, 'movement does not carry over to another held pad');
  appIrig(engine, [0xb1, 95, 125]);
  assert.equal(scene.b, 1);
  appIrig(engine, [0x81, 60, 0]);
  appIrig(engine, [0xb1, 95, 110]);
  assert.equal(scene.a, 0, 'releasing a pad switches gesture target to the remaining held pad');
  appIrig(engine, [0x80, 60, 0]);
  const count = saved.length;
  appIrig(engine, [0xb1, 95, 96]);
  assert.equal(scene.a, 0, '14 unheld steps do not clear A');
  assert.equal(saved.length, count);
  appIrig(engine, [0xb1, 95, 95]);
  assert.equal(scene.a, null);
  appIrig(engine, [0xb1, 95, 109]);
  assert.equal(scene.b, 1);
  appIrig(engine, [0xb1, 95, 110]);
  assert.equal(scene.b, null);
  engine.cancelReleaseLedRefreshes();
  engine.releaseAll();
});

test('FX depth reflects crossfade, pressure, latest held scene and full-depth editing', () => {
  const { engine } = fxSetup([
    { type: 'scene', offsets: [{ channel: 0, cc: 1, offset: 20 }] },
    { type: 'scene', offsets: [{ channel: 0, cc: 1, offset: -20 }] },
    { type: 'custom', slot: 0 },
  ], 0, 1);
  appIrig(engine, [0xb1, 96, 0]);
  assert.deepEqual(engine.fxDepths.slice(0, 3), [1, 0, 0]);
  appIrig(engine, [0xb1, 96, 64]);
  assert.deepEqual(engine.fxDepths.slice(0, 2), [63 / 127, 64 / 127]);
  appIrig(engine, [0x90, 60, 127]);
  assert.deepEqual(engine.fxDepths.slice(0, 2), [1, 0]);
  appIrig(engine, [0x91, 60, 127]);
  assert.deepEqual(engine.fxDepths.slice(0, 2), [0, 1]);
  appIrig(engine, [0x81, 60, 0]);
  appIrig(engine, [0xd0, 0]);
  assert.deepEqual(engine.fxDepths.slice(0, 2), [63 / 127, 64 / 127]);
  engine.opz([0xb0, 2, 20], 0);
  engine.opz([0xb0, 2, 40], 10);
  engine.opz([0xb0, 2, 30], 20);
  assert.deepEqual(engine.fxDepths.slice(0, 2), [1, 0], 'editing uses full depth regardless of pressure');
  appIrig(engine, [0xb1, 93, 127]);
  assert.deepEqual(engine.fxDepths.slice(0, 2), [63 / 127, 64 / 127]);
  appIrig(engine, [0x92, 60, 64]);
  assert.equal(engine.fxDepths[2], 64 / 127);
  appIrig(engine, [0x82, 60, 0]);
  assert.equal(engine.fxDepths[2], 0);
  engine.project.scenes[1].b = 0;
  assert.equal(engine.fxDepths[0], 1, 'assigning both sides to one pad combines their weights');
  engine.releaseAll();
  engine.cancelReleaseLedRefreshes();
});

test('FX projects validate offsets, references and pad types', () => {
  const { engine } = fxSetup([{ type: 'scene', offsets: [{ channel: 0, cc: 1, offset: -127 }] }], 0);
  assert(validateProject(engine.project));
  const invalid = structuredClone(engine.project);
  invalid.scenes[1].pads[0].offsets.push({ channel: 0, cc: 1, offset: 5 });
  assert.equal(validateProject(invalid), false);
  invalid.scenes[1].pads[0] = { type: 'custom', slot: 16 };
  assert.equal(validateProject(invalid), false);
  engine.releaseAll();
});

function setup() {
  const sent = [];
  const saved = [];
  const engine = new Engine({
    send: (destination, bytes) => { sent.push({ destination, bytes }); return true; },
    changed: () => {},
    save: (project) => saved.push(structuredClone(project)),
  });
  engine.setType(1, 'drum');
  appIrig(engine, [0xb1, 96, 127]);
  return { engine, sent, saved };
}

test('mixer controls known OP-Z levels and forwards resulting values without compounding fader changes', () => {
  const sent = [];
  const engine = new Engine({ send: (destination, bytes) => { sent.push({ destination, bytes }); return true; }, changed: () => {}, save: () => {} });
  engine.opz([0xb0, 16, 100]);
  engine.opz([0xb0, 15, 64]);
  assert.deepEqual(sent.filter(({ destination }) => destination === 'iac').map(({ bytes }) => bytes),
    [[0xb0, 16, 100], [0xb0, 15, 64]]);
  sent.length = 0;
  appIrig(engine, [0x90, 60, 100]);
  appIrig(engine, [0xb0, 96, 64]);
  appIrig(engine, [0xb0, 96, 127]);
  appIrig(engine, [0xb0, 95, 50]);
  appIrig(engine, [0xb0, 95, 55]);
  assert.deepEqual(sent.filter(({ destination }) => destination === 'opz').map(({ bytes }) => bytes),
    [[0xb0, 15, 50], [0xb0, 15, 55]]);
  assert.deepEqual(sent.filter(({ destination }) => destination === 'iac').map(({ bytes }) => bytes),
    [[0xb0, 16, 50], [0xb0, 16, 100], [0xb0, 15, 50], [0xb0, 15, 55]]);
  appIrig(engine, [0x80, 60, 0]);
  appIrig(engine, [0x90, 60, 100]);
  appIrig(engine, [0xb0, 96, 64]);
  appIrig(engine, [0x80, 60, 0]);
  appIrig(engine, [0x90, 60, 100]);
  appIrig(engine, [0xb0, 96, 127]);
  assert.equal(engine.mixer.levels[0], 100, 'fader retains the underlying level across pad releases');
  appIrig(engine, [0x80, 60, 0]);
  appIrig(engine, [0x91, 60, 100]);
  sent.length = 0;
  appIrig(engine, [0xb0, 96, 60]);
  assert.equal(sent.filter(({ destination }) => destination === 'opz' || destination === 'iac').length, 0, 'unknown level is not guessed');
});

test('mixer pots set absolute values on all held tracks, even before feedback', () => {
  const sent = [];
  const engine = new Engine({ send: (destination, bytes) => { sent.push({ destination, bytes }); return true; }, changed: () => {}, save: () => {} });
  engine.opz([0xb0, 16, 100]);
  appIrig(engine, [0x90, 60, 100]);
  appIrig(engine, [0x91, 60, 100]);
  appIrig(engine, [0xb0, 96, 64]);
  sent.length = 0;
  appIrig(engine, [0xb0, 94, 80]);
  appIrig(engine, [0xb0, 95, 0]);
  assert.deepEqual(sent.filter(({ destination }) => destination === 'opz').map(({ bytes }) => bytes),
    [[0xb0, 16, 80], [0xb1, 16, 80], [0xb0, 15, 0], [0xb1, 15, 0]]);
  assert.deepEqual(sent.filter(({ destination }) => destination === 'iac').map(({ bytes }) => bytes),
    [[0xb0, 16, 40], [0xb1, 16, 80], [0xb0, 15, 0], [0xb1, 15, 0]]);
  appIrig(engine, [0xb0, 96, 127]);
  assert.deepEqual(engine.mixer.levels.slice(0, 2), [80, 80], 'pot 1 establishes the new fader baseline');
  appIrig(engine, [0xb0, 94, 127]);
  appIrig(engine, [0xb0, 95, 127]);
  assert.deepEqual(engine.mixer.levels.slice(0, 2), [127, 127]);
  assert.deepEqual(engine.mixer.pans.slice(0, 2), [127, 127]);
});

test('mixer LEDs show each track fader scale while retaining the underlying level', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let canSend = true;
  const engine = new Engine({ send: (destination) => destination !== 'iac' || canSend, changed: () => {}, save: () => {} });
  engine.opz([0xb0, 16, 100]);
  engine.opz([0xb1, 16, 40]);
  appIrig(engine, [0x90, 60, 100]);
  appIrig(engine, [0x91, 60, 100]);
  appIrig(engine, [0xb0, 96, 64]);
  assert.deepEqual(engine.mixer.baseLevels.slice(0, 2), [100, 40]);
  assert.deepEqual(engine.mixer.levels.slice(0, 2), [50, 20]);
  assert.deepEqual(engine.leds().slice(0, 3), [[34, 21], [34, 21], [0, 127]]);
  engine.opz([0xb0, 16, 100]);
  assert.deepEqual(engine.leds()[0], [34, 21], 'echo preserves the fader scale');
  engine.opz([0xb0, 53, 1]);
  assert.deepEqual(engine.leds()[0], [0, 0], 'muting overrides the scale');
  engine.opz([0xb0, 53, 0]);
  assert.deepEqual(engine.leds()[0], [34, 21]);
  canSend = false;
  appIrig(engine, [0xb0, 96, 0]);
  assert.deepEqual(engine.leds()[0], [34, 21], 'failed sends do not change the scale');
  canSend = true;
  appIrig(engine, [0xb0, 96, 0]);
  assert.deepEqual(engine.leds().slice(0, 2), [[7, 5], [7, 5]], 'zero fader scale leaves active pads visible');
  appIrig(engine, [0xb0, 94, 80]);
  assert.deepEqual(engine.mixer.baseLevels.slice(0, 2), [80, 80]);
  appIrig(engine, [0x80, 60, 0]);
  appIrig(engine, [0x81, 60, 0]);
  assert.deepEqual(engine.leds().slice(0, 2), [[7, 5], [7, 5]], 'pot 1 preserves the scale');
  assert.deepEqual(engine.mixer.levels.slice(0, 2), [0, 0]);
  appIrig(engine, [0x90, 60, 100]);
  appIrig(engine, [0x91, 60, 100]);
  appIrig(engine, [0xb0, 96, 64]);
  engine.opz([0xb0, 16, 30]);
  assert.equal(engine.mixer.baseLevels[0], 30);
  assert.equal(engine.mixer.levels[0], 15);
  assert.deepEqual(engine.leds()[0], [34, 21], 'new incoming level preserves the scale');
  engine.resetOpz();
  assert.deepEqual(engine.leds().slice(0, 2), [[0, 127], [0, 127]]);
  engine.cancelReleaseLedRefreshes();
});

test('mixer pots show all track values while changing held tracks', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent = [];
  const engine = new Engine({ send: (destination, bytes) => { sent.push({ destination, bytes }); return true; }, changed: () => {}, save: () => {} });
  engine.opz([0xb2, 16, 30]);
  engine.opz([0xb2, 15, 127]);
  appIrig(engine, [0x90, 60, 100]);
  appIrig(engine, [0x91, 60, 100]);
  sent.length = 0;
  appIrig(engine, [0xb0, 94, 80]);
  assert.deepEqual(engine.leds().slice(0, 4), [[0, 80], [0, 80], [0, 30], [0, 0]]);
  assert.deepEqual(sent.filter(({ destination }) => destination === 'opz').map(({ bytes }) => bytes),
    [[0xb0, 16, 80], [0xb1, 16, 80]]);
  t.mock.timers.tick(999);
  sent.length = 0;
  appIrig(engine, [0xb0, 95, 0]);
  assert.deepEqual(engine.leds().slice(0, 4), [[64, 0], [64, 0], [0, 127], [0, 0]]);
  assert.deepEqual(sent.filter(({ destination }) => destination === 'opz').map(({ bytes }) => bytes),
    [[0xb0, 15, 0], [0xb1, 15, 0]]);
  t.mock.timers.tick(5000);
  assert.deepEqual(engine.leds()[0], [64, 0], 'pot display persists while pads are held');
  appIrig(engine, [0x92, 60, 100]);
  appIrig(engine, [0x80, 60, 0]);
  appIrig(engine, [0x81, 60, 0]);
  assert.deepEqual(engine.leds()[0], [64, 0], 'changing held pads preserves the display');
  appIrig(engine, [0xb0, 96, 64]);
  assert.deepEqual(engine.leds()[0], [64, 0], 'fader movement preserves the pot display');
  appIrig(engine, [0xb0, 91, 127]);
  appIrig(engine, [0xb0, 94, 70]);
  assert.deepEqual(engine.leds()[0], [127, 35], 'mute-group display takes precedence');
  appIrig(engine, [0xb0, 91, 0]);
  assert.deepEqual(engine.leds()[0], [0, 80], 'pot display returns while any pad is held');
  appIrig(engine, [0x82, 60, 0]);
  assert.deepEqual(engine.leds()[0], [0, 127], 'releasing the last pad restores the usual display');
  engine.cancelReleaseLedRefreshes();
});

test('mixer fader display transitions to orange at half scale and dims toward zero', () => {
  const sent = [];
  const engine = new Engine({ send: (destination, bytes) => { sent.push({ destination, bytes }); return true; }, changed: () => {}, save: () => {} });
  engine.opz([0xb0, 16, 100]);
  appIrig(engine, [0x90, 60, 100]);
  const colors = [];
  for (const scale of [0, 32, 63, 95, 127]) {
    sent.length = 0;
    appIrig(engine, [0xb0, 96, scale]);
    colors.push(engine.leds()[0]);
    assert.deepEqual(sent.filter(({ destination }) => destination === 'irig').map(({ bytes }) => bytes),
      [[0xb0, 70, colors.at(-1)[1]], [0xb0, 71, colors.at(-1)[0]]]);
  }
  assert.deepEqual(colors[0], [7, 5], 'minimum is a dim but visible orange');
  assert.deepEqual(colors[4], [0, 127]);
  assert(colors[0][0] < colors[1][0] && colors[1][0] < colors[2][0], 'orange gets brighter up to 50%');
  assert.deepEqual(colors[2], [34, 20], '50% is orange with reduced red');
  assert.deepEqual(colors[3], [24, 63], '75% is still transitioning toward orange');
});

test('fader offsets only the virtual bus, including pot changes and OP-Z feedback', () => {
  const sent = [];
  const engine = new Engine({ send: (destination, bytes) => { sent.push({ destination, bytes }); return true; }, changed: () => {}, save: () => {} });
  engine.opz([0xb0, 16, 100]);
  appIrig(engine, [0x90, 60, 100]);
  sent.length = 0;
  appIrig(engine, [0xb0, 96, 64]);
  assert.deepEqual(sent.filter(({ destination }) => destination !== 'irig'), [{ destination: 'iac', bytes: [0xb0, 16, 50] }]);
  sent.length = 0;
  appIrig(engine, [0xb0, 94, 80]);
  assert.deepEqual(sent.filter(({ destination }) => destination !== 'irig'), [
    { destination: 'opz', bytes: [0xb0, 16, 80] },
    { destination: 'iac', bytes: [0xb0, 16, 40] },
  ]);
  sent.length = 0;
  engine.opz([0xb0, 16, 80]);
  engine.opz([0xb0, 16, 60]);
  engine.opz([0xb1, 16, 60]);
  engine.opz([0xb0, 15, 60]);
  assert.deepEqual(sent.filter(({ destination }) => destination === 'iac').map(({ bytes }) => bytes),
    [[0xb0, 16, 40], [0xb0, 16, 30], [0xb1, 16, 60], [0xb0, 15, 60]]);
  assert.equal(engine.mixer.baseLevels[0], 60);
  assert.equal(engine.mixer.levels[0], 30);
  assert.deepEqual(engine.history[0][15].at(-1), { time: engine.history[0][15].at(-1).time, before: 60, after: 30 });
  engine.selectScene(1);
  sent.length = 0;
  engine.opz([0xb0, 16, 100]);
  assert.deepEqual(sent.filter(({ destination }) => destination === 'iac').map(({ bytes }) => bytes), [[0xb0, 16, 50]]);
  engine.cancelReleaseLedRefreshes();
});

test('mixer pot display returns to mute LEDs after one second of inactivity', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent = [];
  let changes = 0;
  const engine = new Engine({ send: (destination, bytes) => { sent.push({ destination, bytes }); return true; }, changed: () => { changes++; }, save: () => {} });
  engine.opz([0xb0, 53, 0]);
  engine.opz([0xb0, 16, 40]);
  engine.opz([0xb0, 15, 70]);
  appIrig(engine, [0xb0, 94, 10]);
  assert.deepEqual(engine.leds()[0], [0, 40]);
  assert.deepEqual(engine.leds()[1], [0, 0], 'unknown level is dark');
  engine.opz([0xb1, 15, 0]);
  t.mock.timers.tick(999);
  assert.deepEqual(engine.leds()[0], [0, 40]);
  appIrig(engine, [0xb0, 95, 10]);
  assert.deepEqual(engine.leds()[0], [29, 70]);
  assert.deepEqual(engine.leds()[1], [64, 0], 'hard left is red');
  assert.deepEqual(engine.leds()[2], [0, 0], 'unknown pan is dark');
  t.mock.timers.tick(999);
  assert.deepEqual(engine.leds()[0], [29, 70]);
  sent.length = 0;
  const previousChanges = changes;
  t.mock.timers.tick(1);
  assert.deepEqual(engine.leds()[0], [0, 127]);
  assert(sent.some(({ destination, bytes }) => destination === 'irig' && bytes.join() === '176,94,127'));
  assert.equal(changes, previousChanges + 1, 'timeout refreshes the UI');
  appIrig(engine, [0xb0, 94, 11]);
  appIrig(engine, [0x90, 60, 100]);
  sent.length = 0;
  t.mock.timers.tick(1000);
  assert.equal(sent.length, 0, 'pad interaction cancels the display timeout');
  appIrig(engine, [0x80, 60, 0]);
  appIrig(engine, [0xb0, 94, 12]);
  engine.selectScene(1);
  t.mock.timers.tick(200);
  sent.length = 0;
  t.mock.timers.tick(800);
  assert.equal(sent.length, 0, 'scene changes cancel the display timeout');
});

test('mixer pan display transitions from red to green and leaves unknown values off', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent = [];
  const engine = new Engine({ send: (destination, bytes) => { sent.push({ destination, bytes }); return true; }, changed: () => {}, save: () => {} });
  engine.opz([0xb0, 15, 0]);
  engine.opz([0xb1, 15, 64]);
  engine.opz([0xb2, 15, 127]);
  engine.opz([0xb1, 53, 1]);
  sent.length = 0;
  appIrig(engine, [0xb0, 95, 10]);
  assert.deepEqual(engine.leds().slice(0, 4), [[64, 0], [32, 64], [0, 127], [0, 0]]);
  assert(sent.some(({ destination, bytes }) => destination === 'irig' && bytes.join() === '176,71,64'), 'hard-left red is sent to the iRig');
  engine.opz([0xb0, 15, 127]);
  assert.deepEqual(engine.leds()[0], [0, 127], 'incoming pan changes update the display');
  t.mock.timers.tick(1000);
  assert.deepEqual(engine.leds()[1], [0, 0], 'muted track is dark again after the timeout');
});

test('mixer assumes group 1 and displays unknown track mutes as green', () => {
  const engine = new Engine({ send: () => true, changed: () => {}, save: () => {} });
  assert.equal(engine.mixer.group, 0);
  assert.equal(engine.mixer.muted[0], null);
  assert.deepEqual(engine.leds()[0], [0, 127]);
  engine.opz([0xb0, 53, 1]);
  assert.equal(engine.mixer.groups[0][0], true);
  assert.deepEqual(engine.leds()[0], [0, 0]);
  engine.opz([0xb0, 53, 0]);
  assert.deepEqual(engine.leds()[0], [0, 127]);
  engine.opz([0xb0, 55, 2]);
  assert.deepEqual(engine.leds()[0], [0, 127], 'unknown tracks in another group are green');
  for (const reset of [
    () => engine.opz([0xc0, 1]),
    () => engine.opz([0xb0, 103, 1]),
    () => engine.resetOpz(),
  ]) {
    engine.opz([0xb0, 55, 2]);
    engine.opz([0xb0, 53, 1]);
    reset();
    assert.equal(engine.mixer.group, 0);
    assert.equal(engine.mixer.groups[2][0], null);
    assert.equal(engine.mixer.muted[0], null);
    assert.deepEqual(engine.leds()[0], [0, 127]);
    engine.opz([0xb0, 53, 1]);
    assert.equal(engine.mixer.groups[0][0], true);
  }
});

test('mixer button 1 and DATA sync the reserved pattern and return to the observed pattern', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent = [];
  const messages = [];
  const engine = new Engine({ send: (destination, bytes) => { sent.push({ destination, bytes }); return true; },
    changed: () => {}, save: () => {}, notify: (message) => messages.push(message) });
  engine.opz([0xc1, 10]);
  engine.opz([0xfa]);
  appIrig(engine, [0xb0, 90, 127]);
  sent.length = 0;
  appIrig(engine, [0xb0, 93, 127]);
  appIrig(engine, [0xb0, 93, 127]);
  assert.deepEqual(sent.filter((m) => m.destination === 'opz').map((m) => m.bytes), [[0xc1, 31]]);
  assert.equal(engine.mixer.muted[0], null, 'modified push does not guess mutes');
  t.mock.timers.tick(299);
  assert.equal(sent.filter((m) => m.destination === 'opz').length, 1);
  t.mock.timers.tick(1);
  const output = sent.filter((m) => m.destination === 'opz').map((m) => m.bytes);
  assert.equal(output.length, 257);
  assert.deepEqual(output.slice(1), Array.from({ length: 256 }, (_, i) =>
    [0xb0 + Math.floor(i / 16), i % 16 + 1, 126]));
  assert(engine.values.every((row) => row.every((value) => value === 126)));
  assert(engine.mixer.baseLevels.every((value) => value === 126));
  t.mock.timers.tick(299);
  assert.equal(sent.filter((m) => m.destination === 'opz').length, 257);
  t.mock.timers.tick(1);
  assert.deepEqual(sent.filter((m) => m.destination === 'opz').at(-1).bytes, [0xc1, 10]);
  engine.opz([0xb0, 1, 37]);
  assert.equal(engine.values[0][0], 37);
  assert.equal(engine.values[0][1], 126);
  assert.match(messages.at(-1), /Verify/);
});

test('sync without an observed pattern leaves calibration selected and asks for a working pattern', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent = [];
  const messages = [];
  const engine = new Engine({ send: (destination, bytes) => { sent.push({ destination, bytes }); return true; },
    changed: () => {}, save: () => {}, notify: (message) => messages.push(message) });
  appIrig(engine, [0xb0, 90, 127]);
  appIrig(engine, [0xb0, 93, 127]);
  t.mock.timers.tick(1000);
  assert.deepEqual(sent.filter((m) => m.destination === 'opz' && (m.bytes[0] & 0xf0) === 0xc0)
    .map((m) => m.bytes), [[0xc1, 31]]);
  assert.match(messages.at(-1), /Select a working pattern/);
});

test('sync handles CC pattern selection and cancels on another observed pattern or send failure', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent = [];
  const messages = [];
  let fail = false;
  const engine = new Engine({ send: (destination, bytes) => {
    if (destination === 'opz') sent.push(bytes);
    return destination !== 'opz' || !fail;
  }, changed: () => {}, save: () => {}, notify: (message) => messages.push(message) });
  const press = () => { appIrig(engine, [0xb0, 93, 127]); appIrig(engine, [0xb0, 93, 0]); };
  engine.opz([0xb2, 103, 5]);
  appIrig(engine, [0xb0, 90, 127]);
  press();
  t.mock.timers.tick(300);
  t.mock.timers.tick(300);
  assert.deepEqual(sent.at(-1), [0xc0, 37], 'CC 103 project and pattern map to default program addressing');
  sent.length = 0;
  press();
  engine.opz([0xc0, 2]);
  t.mock.timers.tick(600);
  assert.deepEqual(sent, [[0xc1, 31]], 'unexpected pattern prevents calibration writes');
  assert.match(messages.at(-1), /cancelled/);
  sent.length = 0;
  fail = true;
  press();
  t.mock.timers.tick(600);
  assert.deepEqual(sent, [[0xc1, 31]], 'failed pattern selection prevents calibration writes');
  assert.match(messages.at(-1), /failed/);
});

test('sync invalidates assumed values if a calibration CC fails and cancels on disconnect', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let opzSends = 0;
  const messages = [];
  const engine = new Engine({ send: (destination) => destination !== 'opz' || ++opzSends !== 4,
    changed: () => {}, save: () => {}, notify: (message) => messages.push(message) });
  engine.opz([0xc0, 8]);
  appIrig(engine, [0xb0, 90, 127]);
  appIrig(engine, [0xb0, 93, 127]);
  t.mock.timers.tick(300);
  assert.equal(opzSends, 4);
  assert(engine.values.every((row) => row.every((value) => value === null)));
  assert(engine.mixer.baseLevels.every((value) => value === null));
  assert.match(messages.at(-1), /failed while sending/);
  appIrig(engine, [0xb0, 93, 0]);
  appIrig(engine, [0xb0, 93, 127]);
  engine.releaseAll();
  t.mock.timers.tick(600);
  assert.equal(opzSends, 5, 'disconnect cancels the pending CC burst');
  assert.match(messages.at(-1), /cancelled/);
});

test('mixer DATA push guesses current group mutes from recent playback channel activity', () => {
  const sent = [];
  const engine = new Engine({ send: (destination, bytes) => { sent.push({ destination, bytes }); return true; }, changed: () => {}, save: () => {} });
  const push = (time) => { appIrig(engine, [0xb0, 93, 127], time); appIrig(engine, [0xb0, 93, 0], time); };
  engine.opz([0x90, 60, 100], 0);
  push(1);
  assert.equal(engine.mixer.muted[0], null, 'unknown transport does not guess');
  engine.opz([0xfa], 100);
  engine.opz([0x91, 60, 100], 101);
  engine.opz([0xe2, 0, 64], 102);
  engine.opz([0xb3, 10, 30], 8100);
  engine.opz([0xf8], 8101);
  engine.opz([0xb0, 55, 2], 8101);
  engine.selectScene(1);
  engine.opz([0x94, 60, 100], 8101);
  appIrig(engine, [0xb1, 93, 127], 8101);
  appIrig(engine, [0xb1, 93, 0], 8101);
  assert.equal(engine.mixer.muted[1], null, 'push in another scene does not guess');
  engine.selectScene(0);
  sent.length = 0;
  push(8101);
  assert.deepEqual(engine.mixer.muted.slice(0, 6), [false, false, false, false, false, true]);
  assert.deepEqual(engine.mixer.groups[2], engine.mixer.muted);
  assert.equal(engine.mixer.groups[0][1], null, 'other groups are not modified');
  assert.equal(sent.filter(({ destination }) => destination !== 'irig').length, 0, 'guess does not send mute commands');
  assert.deepEqual(engine.leds()[5], [0, 0]);
  push(8102);
  assert.equal(engine.mixer.muted[1], true, 'activity older than eight seconds expires');
  assert.equal(engine.mixer.muted[2], false, 'activity exactly eight seconds old counts');
  appIrig(engine, [0xb0, 90, 127], 8103);
  sent.length = 0;
  appIrig(engine, [0x91, 60, 100], 8103);
  assert(sent.some(({ destination, bytes }) => destination === 'opz' && bytes.join() === '177,53,0'),
    'a guessed-muted track is unmuted on its next toggle');
  appIrig(engine, [0x81, 60, 0], 8103);
  appIrig(engine, [0xb0, 90, 0], 8103);
  engine.opz([0xfc], 8200);
  engine.opz([0x95, 60, 100], 8201);
  push(8202);
  assert.equal(engine.mixer.muted[2], false, 'stopped push leaves the prior guess unchanged');
  engine.opz([0xfb], 8300);
  push(8301);
  assert(engine.mixer.muted.every(Boolean), 'continue starts a fresh playback history');
  engine.opz([0x96, 60, 100], 8302);
  engine.opz([0xfa], 8303);
  push(8304);
  assert(engine.mixer.muted.every(Boolean), 'start resets history even if already running');
  engine.opz([0x97, 60, 100], 8305);
  engine.resetOpz();
  engine.opz([0xfa], 8306);
  push(8307);
  assert(engine.mixer.muted.every(Boolean), 'reconnection clears activity');
  engine.cancelReleaseLedRefreshes();
});

test('button 2 highlights the selected mute group and dims the other groups', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent = [];
  let canSend = true;
  const engine = new Engine({ send: (destination, bytes) => { sent.push({ destination, bytes }); return destination !== 'opz' || canSend; }, changed: () => {}, save: () => {} });
  const groupLeds = (index) => Array.from({ length: 16 }, (_, pad) => pad === index ? [127, 35] : pad < 10 ? [7, 5] : [0, 0]);
  engine.opz([0xb0, 16, 50]);
  appIrig(engine, [0xb0, 94, 10]);
  appIrig(engine, [0xd1, 80]);
  sent.length = 0;
  appIrig(engine, [0xb0, 91, 127]);
  assert.deepEqual(engine.leds(), groupLeds(0), 'group display overrides the pot display');
  assert.equal(sent.filter(({ destination }) => destination === 'irig').length, 32, 'button press refreshes even pending pressure LEDs');
  assert(sent.some(({ destination, bytes }) => destination === 'irig' && bytes.join() === '176,72,5'));
  assert(sent.some(({ destination, bytes }) => destination === 'irig' && bytes.join() === '176,73,7'));
  appIrig(engine, [0x92, 60, 100]);
  assert.deepEqual(engine.leds(), groupLeds(2));
  appIrig(engine, [0x82, 60, 0]);
  appIrig(engine, [0x9a, 60, 100]);
  assert.deepEqual(engine.leds(), groupLeds(2), 'pads 11-16 do not select a group');
  appIrig(engine, [0x8a, 60, 0]);
  canSend = false;
  appIrig(engine, [0x93, 60, 100]);
  assert.deepEqual(engine.leds(), groupLeds(2), 'failed group selection keeps the current group');
  appIrig(engine, [0x83, 60, 0]);
  engine.opz([0xb0, 55, 9]);
  assert.deepEqual(engine.leds(), groupLeds(9), 'incoming group changes update the display');
  t.mock.timers.tick(200);
  assert.deepEqual(engine.leds(), groupLeds(9), 'delayed release refreshes keep the group display');
  appIrig(engine, [0xb0, 91, 0]);
  assert.deepEqual(engine.leds(), Array.from({ length: 16 }, () => [0, 127]), 'button release restores the track display');
});

test('mixer toggles unknown mute, sends channel-specific note stops, and tracks selected groups', () => {
  const sent = [];
  const engine = new Engine({ send: (destination, bytes) => { sent.push({ destination, bytes }); return true; }, changed: () => {}, save: () => {} });
  appIrig(engine, [0xb0, 91, 127]);
  appIrig(engine, [0x92, 60, 100]);
  assert.equal(engine.mixer.group, 2);
  assert.equal(engine.mixer.groups[2][1], null);
  assert(sent.some(({ destination, bytes }) => destination === 'opz' && bytes.join() === '176,55,2'));
  appIrig(engine, [0x82, 60, 0]);
  appIrig(engine, [0xb0, 91, 0]);
  appIrig(engine, [0xb0, 90, 127]);
  sent.length = 0;
  appIrig(engine, [0x91, 60, 100]);
  assert.equal(engine.mixer.groups[2][1], true);
  assert.deepEqual(sent.filter(({ destination }) => destination !== 'irig'), [
    { destination: 'opz', bytes: [0xb1, 53, 1] },
    { destination: 'iac', bytes: [0xb1, 120, 0] },
    { destination: 'iac', bytes: [0xb1, 123, 0] },
  ]);
  appIrig(engine, [0x81, 60, 0]);
  appIrig(engine, [0x91, 60, 100]);
  assert.equal(engine.mixer.groups[2][1], false);
  engine.opz([0xb1, 53, 1]);
  assert.equal(engine.mixer.groups[2][1], true);
  engine.opz([0xb0, 55, 3]);
  assert.equal(engine.mixer.muted[1], null, 'another group remains unknown');
  engine.opz([0xb0, 55, 2]);
  assert.equal(engine.mixer.muted[1], true);
  engine.opz([0xc0, 1]);
  assert.equal(engine.mixer.groups[2][1], null, 'pattern changes invalidate group observations');
  engine.resetOpz();
  assert.equal(engine.mixer.groups[2][1], null);
});

test('OP-Z forwards unrecognized MIDI messages to the virtual output unchanged', () => {
  const sent = [];
  const engine = new Engine({ send: (destination, bytes) => { sent.push({ destination, bytes }); return true; }, changed: () => {}, save: () => {} });
  for (const data of [[0xf8], [0xe2, 0, 64], [0xc1, 7], [0x91, 60, 100]]) engine.opz(data);
  assert.deepEqual(sent.filter(({ destination }) => destination === 'iac').map(({ bytes }) => bytes),
    [[0xf8], [0xe2, 0, 64], [0xc1, 7], [0x91, 60, 100]]);
});

test('failed OP-Z mixer commands do not update the displayed state', () => {
  const sent = [];
  const engine = new Engine({
    send: (destination, bytes) => { sent.push({ destination, bytes }); return destination !== 'opz'; },
    changed: () => {}, save: () => {},
  });
  engine.opz([0xb0, 16, 100]);
  appIrig(engine, [0x90, 60, 100]);
  appIrig(engine, [0xb0, 94, 64]);
  assert.equal(engine.mixer.levels[0], 100);
  assert.equal(sent.filter(({ destination, bytes }) => destination === 'iac' && bytes[1] === 16).length, 1);
  appIrig(engine, [0x80, 60, 0]);
  appIrig(engine, [0xb0, 90, 127]);
  appIrig(engine, [0x90, 60, 100]);
  assert.equal(engine.mixer.muted[0], null);
});

test('MIDI decoding normalizes note-off and rejects incomplete or unrelated messages', () => {
  assert.deepEqual(decodeMidi([0x92, 60, 0]), { type: 'note', channel: 2, note: 60, velocity: 0, on: false });
  assert.equal(decodeMidi([0x90, 60]), null);
  assert.equal(decodeMidi([0xb0, 10]), null);
  assert.deepEqual(decodeMidi([0xfb]), { type: 'transport', state: 'running' });
  assert.equal(decodeIrig([0xc3, 15]), null);
  assert.equal(decodeIrig([0xb1, 20, 127]), null);
  for (const cc of [1, 7, 10, 11, 22]) assert.equal(decodeIrig([0xb0, cc, 127]), null);
  for (const cc of [94, 95]) {
    assert.deepEqual(decodeIrig([0xb1, cc, 64]), { type: 'control', control: cc, value: 64 });
  }
  assert.deepEqual(decodeIrig([0xb1, 96, 64]), { type: 'control', control: 96, value: 64, scene: 13 });
  assert.deepEqual(decodeIrig([0xbf, 92, 1]), { type: 'control', control: 92, value: 1 });
  assert.deepEqual(decodeIrig([0xbf, 93, 127]), { type: 'push', pressed: true });
  assert.deepEqual(decodeIrig([0xbf, 93, 0]), { type: 'push', pressed: false });
  assert.equal(decodeIrig([0xb0, 93, 1]), null);
  assert.equal(decodeIrig([0x90, 48, 100]), null);
  assert.deepEqual(decodeIrig([0x90, 60, 100]), { type: 'pad', index: 12, on: true, velocity: 100 });
  for (let channel = 0; channel < 16; channel++) {
    assert.deepEqual(decodeIrig([0xb0 + channel, 90, 127]), { type: 'button', index: 0, pressed: true });
    assert.deepEqual(decodeIrig([0xb0 + channel, 91, 0]), { type: 'button', index: 1, pressed: false });
    for (const cc of [92, 94, 95]) {
      assert.deepEqual(decodeIrig([0xb0 + channel, cc, 1]), { type: 'control', control: cc, value: 1 });
    }
    assert.deepEqual(decodeIrig([0xb0 + channel, 96, 1]), { type: 'control', control: 96, value: 1, scene: flipPadIndex(channel) });
    assert.deepEqual(decodeIrig([0xb0 + channel, 93, 127]), { type: 'push', pressed: true });
    assert.equal(decodeIrig([0xb0 + channel, 90, 1]), null);
  }
  assert.deepEqual(decodeIrig([0xd5, 75]), { type: 'pressure', index: 9, value: 75 });
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
  assert.deepEqual(controller.pots, [67, null]);
  controller.move(95, 127);
  assert.deepEqual(controller.pots, [67, 127]);
  assert.equal(controller.move(92, 127), -1);
  controller.resetControls();
  assert.deepEqual(controller.pots, [67, 127], 'last pot positions survive gesture baseline resets');
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
  appIrig(engine, [0xd0, 30], 10);
  assert.equal(events.length, 0, 'unheld pads ignore pressure');
  sent.length = 0;
  appIrig(engine, [0x90, 60, 50], 11);
  appIrig(engine, [0xd0, 70], 12);
  appIrig(engine, [0xb1, 94, 64], 13);
  engine.opz([0xb1, 5, 75], 14);
  engine.opz([0xfc], 15);
  assert.deepEqual(events.map(({ event }) => [event.type, event.time]), [
    ['pad', 11], ['pressure', 12], ['control', 13], ['midi', 14], ['midi', 15],
  ]);
  assert.equal(events[1].pressure, 70, 'controller state is updated before dispatch');
  assert.equal(events[4].event.transport, 'stopped');
  assert.deepEqual(sent.filter(({ destination }) => destination === 'irig').map(({ bytes }) => bytes), [
    [0xb0, 70, 0], [0xb0, 71, 50],
  ], 'other updates do not flush a pending pressure LED');
  sent.length = 0;
  engine.refreshLeds();
  assert.equal(sent.filter(({ destination }) => destination === 'irig').length, 32, 'explicit refresh reconciles all LEDs');
});

test('pad interactions restore the intended mixer LED even when its color is unchanged', () => {
  const sent = [];
  const engine = new Engine({ send: (destination, bytes) => { sent.push({ destination, bytes }); return true; }, changed: () => {}, save: () => {} });
  engine.opz([0xb0, 53, 0]);
  sent.length = 0;
  for (const data of [[0x90, 60, 100], [0xd0, 64], [0x90, 60, 100], [0x80, 60, 0], [0x80, 60, 0]]) appIrig(engine, data);
  assert.deepEqual(sent.filter(({ destination }) => destination === 'irig').map(({ bytes }) => bytes),
    Array.from({ length: 4 }, () => [[0xb0, 70, 127], [0xb0, 71, 0]]).flat());
  engine.cancelReleaseLedRefreshes();
  engine.releaseAll();
});

test('pad release reconciles the latest LED state after the iRig changes it', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent = [];
  const engine = new Engine({ send: (destination, bytes) => { sent.push({ destination, bytes }); return true; }, changed: () => {}, save: () => {} });
  engine.opz([0xb0, 53, 0]);
  appIrig(engine, [0x90, 60, 100]);
  appIrig(engine, [0xb0, 94, 80]);
  sent.length = 0;
  appIrig(engine, [0x80, 60, 0]);
  const leds = () => sent.filter(({ destination, bytes }) => destination === 'irig' && (bytes[1] === 70 || bytes[1] === 71)).map(({ bytes }) => bytes);
  assert.deepEqual(leds(), [[0xb0, 70, 127], [0xb0, 71, 0]], 'release refreshes immediately');
  t.mock.timers.tick(199);
  assert.equal(leds().length, 2);
  engine.opz([0xb0, 53, 1]);
  sent.length = 0;
  t.mock.timers.tick(1);
  assert.deepEqual(leds(), [[0xb0, 70, 0], [0xb0, 71, 0]], 'delayed refresh uses current state');
  appIrig(engine, [0x90, 60, 100]);
  appIrig(engine, [0x80, 60, 0]);
  appIrig(engine, [0x90, 60, 100]);
  sent.length = 0;
  t.mock.timers.tick(200);
  assert.deepEqual(leds(), [[0xb0, 70, 0], [0xb0, 71, 0]], 'another press does not cancel the release refresh');
  appIrig(engine, [0x80, 60, 0]);
  engine.releaseAll();
  sent.length = 0;
  t.mock.timers.tick(200);
  assert.deepEqual(leds(), [[0xb0, 70, 0], [0xb0, 71, 0]], 'releaseAll does not cancel the release refresh');
});

test('every rapid pad release refreshes the current state after 200ms, including button-modified taps', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent = [];
  const engine = new Engine({ send: (destination, bytes) => { sent.push({ destination, bytes }); return true; }, changed: () => {}, save: () => {} });
  engine.opz([0xb9, 53, 1]);
  appIrig(engine, [0xb0, 90, 127]);
  appIrig(engine, [0x99, 60, 100]);
  appIrig(engine, [0x89, 60, 0]);
  t.mock.timers.tick(50);
  appIrig(engine, [0x99, 60, 100]);
  appIrig(engine, [0x89, 60, 0]);
  appIrig(engine, [0xb0, 90, 0]);
  sent.length = 0;
  t.mock.timers.tick(149);
  assert.equal(sent.filter(({ destination }) => destination === 'irig').length, 0);
  t.mock.timers.tick(1);
  assert.deepEqual(sent.filter(({ destination }) => destination === 'irig').map(({ bytes }) => bytes),
    [[0xb0, 88, 0], [0xb0, 89, 0]], 'first release refreshes latest muted state');
  engine.opz([0xb9, 53, 0]);
  sent.length = 0;
  t.mock.timers.tick(50);
  assert.deepEqual(sent.filter(({ destination }) => destination === 'irig').map(({ bytes }) => bytes),
    [[0xb0, 88, 127], [0xb0, 89, 0]], 'second release refreshes the new active state');
  appIrig(engine, [0x89, 60, 0]);
  engine.selectScene(1);
  sent.length = 0;
  t.mock.timers.tick(200);
  assert.deepEqual(sent.filter(({ destination }) => destination === 'irig').map(({ bytes }) => bytes),
    [[0xb0, 88, 0], [0xb0, 89, 0]], 'scene change still refreshes the new scene state');
  appIrig(engine, [0x89, 60, 0]);
  engine.cancelReleaseLedRefreshes();
  sent.length = 0;
  t.mock.timers.tick(200);
  assert.equal(sent.length, 0, 'explicit shutdown cancels outstanding timers');
});

test('pressure LED refreshes are coalesced, deliver latest state, and cancel on release', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { engine, sent } = setup();
  engine.handlers.drum = {
    leds: (_scene, controller) => controller.pressure.map((value) => [value, 0]),
    handle: () => {}, release: () => {},
  };
  appIrig(engine, [0x90, 60, 10]);
  appIrig(engine, [0x91, 60, 20]);
  sent.length = 0;
  for (const value of [30, 40, 50]) appIrig(engine, [0xd0, value]);
  appIrig(engine, [0xd1, 60]);
  engine.opz([0xb0, 15, 10]);
  assert.equal(sent.filter(({ destination }) => destination === 'irig').length, 0);
  t.mock.timers.tick(49);
  assert.equal(sent.filter(({ destination }) => destination === 'irig').length, 0);
  t.mock.timers.tick(1);
  const leds = () => sent.filter(({ destination }) => destination === 'irig').map(({ bytes }) => bytes);
  assert.deepEqual(leds(), [[0xb0, 70, 0], [0xb0, 71, 50], [0xb0, 72, 0], [0xb0, 73, 60]]);
  sent.length = 0;
  appIrig(engine, [0xd0, 51]);
  t.mock.timers.tick(25);
  appIrig(engine, [0xd0, 52]);
  t.mock.timers.tick(24);
  assert.equal(leds().length, 0, 'continuous pressure stays rate-limited');
  t.mock.timers.tick(1);
  assert.deepEqual(leds(), [[0xb0, 70, 0], [0xb0, 71, 52]], 'latest pressure is sent on the next interval');
  sent.length = 0;
  appIrig(engine, [0xd0, 70]);
  appIrig(engine, [0xd0, 80]);
  appIrig(engine, [0x80, 60, 0]);
  assert.deepEqual(leds(), [[0xb0, 70, 0], [0xb0, 71, 0]], 'release restores LEDs immediately');
  t.mock.timers.tick(50);
  assert.equal(leds().length, 2, 'release cancels the queued pressure refresh');
  engine.cancelReleaseLedRefreshes();
  appIrig(engine, [0xd1, 90]);
  sent.length = 0;
  engine.releaseAll();
  t.mock.timers.tick(50);
  assert.equal(leds().length, 0, 'releaseAll cancels pending refreshes');
});

test('device adapter preserves MIDI event timestamps', () => {
  const input = { id: 'irig', state: 'connected', onmidimessage: null };
  const devices = new MidiDevices({ inputs: new Map([['irig', input]]), outputs: new Map() });
  const received = [];
  devices.configureInputs('irig', '', (bytes, time) => received.push([Array.from(bytes), time]), () => {});
  input.onmidimessage({ data: Uint8Array.from([0xd0, 64]), timeStamp: 123.5 });
  assert.deepEqual(received, [[[0xd0, 64], 123.5]]);
});

test('drum pad hits flash independently, retrigger on quick taps, and clear on scene changes', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { engine } = setup();
  appIrig(engine, [0x90, 60, 100]);
  const firstHit = engine.drumFlashes[0];
  assert.notEqual(firstHit, 0);
  appIrig(engine, [0x80, 60, 0]);
  t.mock.timers.tick(100);
  appIrig(engine, [0x91, 60, 100]);
  appIrig(engine, [0x90, 60, 100]);
  assert.notEqual(engine.drumFlashes[0], firstHit, 'another hit restarts the flash');
  assert.notEqual(engine.drumFlashes[1], 0);
  t.mock.timers.tick(150);
  assert.notEqual(engine.drumFlashes[0], 0, 'old timer does not clear a retriggered flash');
  t.mock.timers.tick(100);
  assert.deepEqual(engine.drumFlashes.slice(0, 2), [0, 0]);
  appIrig(engine, [0x80, 60, 0]);
  appIrig(engine, [0x90, 60, 100]);
  engine.selectScene(0);
  assert.equal(engine.drumFlashes[0], 0, 'scene changes clear pending flashes');
  appIrig(engine, [0x90, 60, 100]);
  assert.equal(engine.drumFlashes[0], 0, 'mixer pad presses do not flash drum cards');
  engine.cancelReleaseLedRefreshes();
  engine.releaseAll();
});

test('learning requires stopped transport and scene changes release notes', () => {
  const { engine, sent, saved } = setup();
  appIrig(engine, [0x90, 60, 100]);
  engine.opz([0x91, 40, 100]);
  assert.equal(engine.project.scenes[1].pads[0], null);
  engine.opz([0xfc]);
  engine.opz([0x91, 40, 100]);
  assert.deepEqual(engine.project.scenes[1].pads[0], { channel: 1, note: 40, velocity: 127 });
  assert.deepEqual(saved.at(-1).scenes[1].pads[0], { channel: 1, note: 40, velocity: 127 });
  appIrig(engine, [0x80, 60, 0]);
  appIrig(engine, [0x90, 60, 100]);
  assert(sent.some(({ destination, bytes }) => destination === 'opz' && bytes.join() === '145,40,100'));
  sent.length = 0;
  appIrig(engine, [0xb0, 96, 64]);
  assert(sent.some(({ destination, bytes }) => destination === 'opz' && bytes.join() === '129,40,0'));
  assert(sent.filter(({ destination }) => destination === 'irig').length >= 32, 'scene detection refreshes all LEDs');
  assert.equal(engine.held[0], false);
  assert.equal(engine.scene, 0);
  assert.equal(engine.fader, 64, 'scene-changing fader value is applied to the new scene');
  appIrig(engine, [0xbf, 90, 0]);
  assert.equal(engine.scene, 0, 'a button release does not switch scenes');
  appIrig(engine, [0xbf, 96, 127]);
  assert.equal(engine.scene, 15);
  appIrig(engine, [0xc0, 0]);
  assert.equal(engine.scene, 15, 'program changes do not switch scenes');
});

test('drum pads learn and play channel 13 performance FX notes while stopped', () => {
  const { engine, sent, saved } = setup();
  appIrig(engine, [0x90, 60, 100]);
  engine.opz([0xfa]);
  engine.opz([0x9c, 48, 100]);
  assert.equal(engine.project.scenes[1].pads[0], null, 'learning is disabled while running');
  engine.opz([0xfc]);
  engine.opz([0x9b, 48, 100]);
  engine.opz([0x9d, 48, 100]);
  assert.equal(engine.project.scenes[1].pads[0], null, 'adjacent channels are not learned');
  engine.opz([0x9c, 48, 100]);
  assert.deepEqual(engine.project.scenes[1].pads[0], { channel: 12, note: 48, velocity: 127 });
  assert(sent.some(({ destination, bytes }) => destination === 'iac' && bytes.join() === '156,48,100'),
    'OP-Z-originated notes are still forwarded');
  assert.equal(validateProject(saved.at(-1)), true);
  assert.deepEqual(engine.leds()[0], [0, 127], 'performance FX is green when held');
  appIrig(engine, [0xb1, 96, 90]);
  appIrig(engine, [0x80, 60, 0]);
  assert.deepEqual(engine.leds()[0], [0, 57], 'performance FX is dim green when released');
  sent.length = 0;
  appIrig(engine, [0x90, 60, 100]);
  appIrig(engine, [0x80, 60, 0]);
  assert.deepEqual(sent.filter(({ destination }) => destination === 'opz').map(({ bytes }) => bytes),
    [[0x9c, 48, 71], [0x8c, 48, 0]]);
  assert.deepEqual(sent.filter(({ destination }) => destination === 'iac'), []);
  engine.cancelReleaseLedRefreshes();
  engine.releaseAll();
});

test('performance FX auditions and scene release send notes only to OP-Z', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { engine, sent } = setup();
  engine.project.scenes[1].pads[0] = { channel: 12, note: 48, velocity: 127 };
  engine.project.scenes[1].pads[1] = { channel: 0, note: 36, velocity: 127 };
  appIrig(engine, [0x90, 60, 100]);
  appIrig(engine, [0x91, 60, 100]);
  appIrig(engine, [0xb1, 94, 64]);
  t.mock.timers.tick(120);
  engine.selectScene(0);
  const notes = (destination, channel) => sent.filter((message) => message.destination === destination &&
    (message.bytes[0] === 0x90 + channel || message.bytes[0] === 0x80 + channel)).map(({ bytes }) => bytes);
  assert.deepEqual(notes('opz', 12), [
    [0x9c, 48, 100], [0x8c, 48, 0], [0x9c, 48, 127],
    [0x8c, 48, 0], [0x9c, 48, 127], [0x8c, 48, 0],
  ]);
  assert.deepEqual(notes('iac', 12), []);
  assert.deepEqual(notes('iac', 0), notes('opz', 0), 'drum notes still reach both outputs');
  engine.cancelReleaseLedRefreshes();
});

test('drum note learning preserves maximum velocity and ignores the assigned note', () => {
  const { engine, sent, saved } = setup();
  engine.opz([0xfc]);
  appIrig(engine, [0x90, 60, 100]);
  engine.opz([0x91, 40, 100]);
  appIrig(engine, [0xb1, 96, 90]);
  appIrig(engine, [0x80, 60, 0]);

  sent.length = 0;
  const savesBeforePlay = saved.length;
  appIrig(engine, [0x90, 60, 100]);
  assert(sent.some(({ destination, bytes }) => destination === 'opz' && bytes.join() === '145,40,71'));
  engine.opz([0x91, 40, 71]);
  assert.deepEqual(engine.project.scenes[1].pads[0], { channel: 1, note: 40, velocity: 90 });
  assert.equal(saved.length, savesBeforePlay);
  assert(!sent.some(({ destination, bytes }) => destination === 'opz' && bytes.join() === '129,40,0'));

  engine.opz([0x92, 41, 100]);
  assert.deepEqual(engine.project.scenes[1].pads[0], { channel: 2, note: 41, velocity: 90 });
  assert.deepEqual(saved.at(-1).scenes[1].pads[0], { channel: 2, note: 41, velocity: 90 });
  assert(sent.some(({ destination, bytes }) => destination === 'opz' && bytes.join() === '129,40,0'));
  appIrig(engine, [0x80, 60, 0]);
  appIrig(engine, [0x90, 60, 127]);
  assert(sent.some(({ destination, bytes }) => destination === 'opz' && bytes.join() === '146,41,90'));
});

test('drum playback exposes each note velocity through audition and its minimum display time', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { engine } = setup();
  engine.project.scenes[1].pads[0] = { channel: 0, note: 36, velocity: 90 };
  engine.project.scenes[1].pads[1] = { channel: 1, note: 40, velocity: 0 };
  appIrig(engine, [0x90, 60, 100]);
  appIrig(engine, [0x91, 60, 100]);
  assert.deepEqual(engine.drumVelocities.slice(0, 2), [71, 1]);
  appIrig(engine, [0xd0, 20]);
  assert.equal(engine.drumVelocities[0], 71, 'aftertouch does not change note-on velocity');
  appIrig(engine, [0x80, 60, 0]);
  assert.deepEqual(engine.drumVelocities.slice(0, 2), [71, 1]);
  appIrig(engine, [0x90, 60, 127]);
  assert.equal(engine.drumVelocities[0], 90);
  appIrig(engine, [0xb1, 94, 50]);
  appIrig(engine, [0xb1, 96, 60]);
  t.mock.timers.tick(120);
  assert.equal(engine.drumVelocities[0], 60, 'audition shows the velocity of the repeated note');
  t.mock.timers.tick(80);
  assert.deepEqual(engine.drumVelocities.slice(0, 2), [60, 60], 'audition velocities remain after note off');
  t.mock.timers.tick(169);
  assert.deepEqual(engine.drumVelocities.slice(0, 2), [60, 60]);
  t.mock.timers.tick(1);
  assert.deepEqual(engine.drumVelocities.slice(0, 2), [null, null], 'audition display expires 250 ms after its last hit');
  engine.cancelReleaseLedRefreshes();
  engine.releaseAll();
});

test('velocity display survives quick releases, retriggers, and long holds independently', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { engine } = setup();
  engine.project.scenes[1].pads[0] = { channel: 0, note: 36, velocity: 127 };
  engine.project.scenes[1].pads[1] = { channel: 1, note: 40, velocity: 127 };
  appIrig(engine, [0x90, 60, 20]);
  appIrig(engine, [0x80, 60, 0]);
  appIrig(engine, [0x91, 60, 40]);
  t.mock.timers.tick(100);
  appIrig(engine, [0x90, 60, 80]);
  appIrig(engine, [0x80, 60, 0]);
  t.mock.timers.tick(149);
  assert.deepEqual(engine.drumVelocities.slice(0, 2), [80, 40]);
  t.mock.timers.tick(100);
  assert.deepEqual(engine.drumVelocities.slice(0, 2), [80, 40], 'held notes remain visible past 250 ms');
  t.mock.timers.tick(1);
  assert.deepEqual(engine.drumVelocities.slice(0, 2), [null, 40], 'retrigger remains for its own full 250 ms');
  appIrig(engine, [0x81, 60, 0]);
  assert.equal(engine.drumVelocities[1], null, 'a long-held note clears immediately on release');
  appIrig(engine, [0x90, 60, 30]);
  engine.selectScene(0);
  assert.equal(engine.drumVelocities[0], null, 'scene changes clear pending velocity displays');
  engine.cancelReleaseLedRefreshes();
});

test('only faders switch scenes; other controls work on any MIDI channel', () => {
  for (const [cc, value, type] of [[90, 127, 'button'], [91, 127, 'button'], [92, 1, 'control'], [93, 127, 'push'],
    [94, 64, 'control'], [95, 64, 'control']]) {
    const { engine, sent } = setup();
    const events = [];
    engine.handlers.drum = {
      leds: () => Array.from({ length: 16 }, () => [0, 0]),
      handle: (_scene, _controller, event) => events.push(event),
      release: () => {},
    };
    sent.length = 0;
    appIrig(engine, [0xbf, cc, value], 100);
    assert.equal(engine.scene, 1, `CC ${cc} does not switch scenes`);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, type);
    assert.equal(events[0].time, 100);
    if (cc === 92) assert.equal(events[0].delta, 1, 'relative turn is applied immediately');
    if (cc === 93) assert.equal(engine.push, true);
    appIrig(engine, [0xbf, 96, 64], 101);
    assert.equal(engine.scene, 15, 'fader channel identifies the scene');
    assert.equal(engine.fader, 64, 'fader is processed after switching');
    assert(sent.filter(({ destination }) => destination === 'irig').length >= 32, 'scene switch refreshes LEDs');
  }
});

test('drum controls send absolute values once per channel and cancel auditions on release', async () => {
  const { engine, sent } = setup();
  engine.opz([0xfc]);
  appIrig(engine, [0x90, 60, 100]);
  appIrig(engine, [0x91, 60, 100]);
  engine.opz([0x91, 40, 100]);
  appIrig(engine, [0xb1, 94, 64]);
  sent.length = 0;
  appIrig(engine, [0xb1, 94, 66]);
  for (const destination of ['opz', 'iac']) {
    assert.deepEqual(sent.filter((message) => message.destination === destination && message.bytes[1] === 1)
      .map(({ bytes }) => bytes), [[0xb1, 1, 66]]);
  }
  engine.releaseAll();
  const count = sent.length;
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(sent.length, count);
});

test('DATA adjusts absolute values per channel and parameter using observed and sent values', () => {
  const { engine, sent } = setup();
  engine.opz([0xfc]);
  appIrig(engine, [0x90, 60, 100]);
  engine.opz([0x91, 40, 100]);
  engine.opz([0xb1, 3, 100]);
  sent.length = 0;
  appIrig(engine, [0xb1, 92, 1]);
  appIrig(engine, [0xb1, 92, 127]);
  appIrig(engine, [0xb1, 93, 127]);
  appIrig(engine, [0xb1, 92, 1]);
  appIrig(engine, [0xb1, 93, 0]);
  appIrig(engine, [0xb1, 92, 1]);
  for (const destination of ['opz', 'iac']) {
    assert.deepEqual(sent.filter((message) => message.destination === destination && message.bytes[0] === 0xb1)
      .map(({ bytes }) => bytes), [[0xb1, 3, 101], [0xb1, 3, 100], [0xb1, 4, 65], [0xb1, 3, 101]]);
  }
  engine.opz([0xb1, 3, 127]);
  sent.length = 0;
  appIrig(engine, [0xb1, 92, 10]);
  engine.opz([0xb1, 3, 0]);
  appIrig(engine, [0xb1, 92, 118]);
  assert.deepEqual(sent.filter(({ destination, bytes }) => destination === 'opz' && bytes[0] === 0xb1)
    .map(({ bytes }) => bytes), [[0xb1, 3, 127], [0xb1, 3, 0]]);
  engine.resetOpz();
  sent.length = 0;
  appIrig(engine, [0xb1, 92, 1]);
  assert(sent.some(({ destination, bytes }) => destination === 'opz' && bytes.join() === '177,3,65'));
  engine.releaseAll();
});

test('DATA tracks each held drum channel independently and absolute fader sets compression immediately', () => {
  const { engine, sent } = setup();
  const scene = engine.project.scenes[1];
  scene.pads[0] = { channel: 0, note: 36, velocity: 127 };
  scene.pads[1] = { channel: 1, note: 40, velocity: 127 };
  engine.opz([0xb0, 3, 20]);
  engine.opz([0xb1, 3, 100]);
  appIrig(engine, [0x90, 60, 100]);
  appIrig(engine, [0x91, 60, 100]);
  sent.length = 0;
  appIrig(engine, [0xb1, 92, 3]);
  appIrig(engine, [0xb1, 90, 127]);
  appIrig(engine, [0xb1, 96, 42]);
  for (const destination of ['opz', 'iac']) {
    assert.deepEqual(sent.filter((message) => message.destination === destination
      && (message.bytes[0] & 0xf0) === 0xb0).map(({ bytes }) => bytes),
    [[0xb0, 3, 23], [0xb1, 3, 103], [0xb0, 9, 42], [0xb1, 9, 42]]);
  }
  engine.releaseAll();
});

test('drum notes and audition repeats reach both outputs through release', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { engine, sent } = setup();
  engine.opz([0xfc]);
  appIrig(engine, [0x90, 60, 100]);
  engine.opz([0x91, 40, 100]);
  appIrig(engine, [0x80, 60, 0]);
  sent.length = 0;
  appIrig(engine, [0x90, 60, 90]);
  appIrig(engine, [0xb1, 94, 50]);
  t.mock.timers.tick(120);
  appIrig(engine, [0x80, 60, 0]);
  const notes = (destination) => sent.filter((message) => message.destination === destination
    && (message.bytes[0] & 0xf0) !== 0xb0).map(({ bytes }) => bytes);
  assert.deepEqual(notes('opz'), [
    [0x91, 40, 90], [0x81, 40, 0], [0x91, 40, 127],
    [0x81, 40, 0], [0x91, 40, 127], [0x81, 40, 0],
  ]);
  assert.deepEqual(notes('iac'), notes('opz'));
  engine.cancelReleaseLedRefreshes();
});

test('drum absolute controls update the mixer and scale Ableton level', () => {
  const { engine, sent } = setup();
  engine.selectScene(0);
  engine.opz([0xb1, 16, 100]);
  appIrig(engine, [0x91, 60, 100]);
  appIrig(engine, [0xb0, 96, 64]);
  appIrig(engine, [0x81, 60, 0]);
  engine.selectScene(1);
  engine.opz([0xfc]);
  appIrig(engine, [0x90, 60, 100]);
  engine.opz([0x91, 40, 100]);
  appIrig(engine, [0xb1, 91, 127]);
  appIrig(engine, [0xb1, 93, 127]);
  sent.length = 0;
  appIrig(engine, [0xb1, 92, 1]);
  assert(sent.some(({ destination, bytes }) => destination === 'opz' && bytes.join() === '177,16,101'));
  assert(sent.some(({ destination, bytes }) => destination === 'iac' && bytes.join() === '177,16,51'));
  assert.equal(engine.mixer.baseLevels[1], 101);
  assert.equal(engine.mixer.levels[1], 51);
  engine.releaseAll();
});

test('project validation checks scene and pad invariants', () => {
  const project = newProject();
  assert.equal(validateProject(project), true);
  project.scenes[1] = { type: 'drum', pads: Array(16).fill(null) };
  project.scenes[1].pads[0] = { channel: 4, note: 40, velocity: 127 };
  assert.equal(validateProject(project), false);
  project.scenes[1].pads[0].channel = 12;
  assert.equal(validateProject(project), true);
  project.scenes[1].pads[0].channel = 13;
  assert.equal(validateProject(project), false);
  assert.throws(() => setup().engine.setProject(project), /Invalid or unsupported/);
});

test('replacing the active drum scene releases its playing notes', () => {
  const { engine, sent } = setup();
  engine.opz([0xfc]);
  appIrig(engine, [0x90, 60, 100]);
  engine.opz([0x90, 40, 100]);
  appIrig(engine, [0x80, 60, 0]);
  appIrig(engine, [0x90, 60, 100]);
  sent.length = 0;
  engine.setType(1, 'empty');
  assert(sent.some(({ destination, bytes }) => destination === 'opz' && bytes.join() === '128,40,0'));
  assert.equal(engine.held[0], false);
  assert.equal(engine.project.scenes[1].type, 'empty');
});

test('loading a kit validates and copies it, releases active notes, and cannot replace the mixer', () => {
  const { engine, sent } = setup();
  engine.opz([0xfc]);
  appIrig(engine, [0x90, 60, 100]);
  engine.opz([0x90, 40, 100]);
  appIrig(engine, [0x80, 60, 0]);
  appIrig(engine, [0x90, 60, 100]);
  const kit = { type: 'drum', pads: Array(16).fill(null) };
  kit.pads[0] = { channel: 1, note: 50, velocity: 80 };
  assert.throws(() => engine.setKit(0, kit), /Invalid scene or drum kit/);
  assert.throws(() => engine.setKit(1, { type: 'drum', pads: [] }), /Invalid scene or drum kit/);
  sent.length = 0;
  engine.setKit(1, kit);
  for (const destination of ['opz', 'iac']) {
    assert(sent.some((message) => message.destination === destination && message.bytes.join() === '128,40,0'));
  }
  engine.project.scenes[1].pads[0].velocity = 20;
  assert.equal(kit.pads[0].velocity, 80, 'the saved kit is not mutated through the loaded scene');
  engine.cancelReleaseLedRefreshes();
});
