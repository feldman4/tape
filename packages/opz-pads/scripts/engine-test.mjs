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
    send: (destination, bytes) => { sent.push({ destination, bytes }); return true; },
    changed: () => {},
    save: (project) => saved.push(structuredClone(project)),
  });
  engine.setType(1, 'drum');
  engine.irig([0xb1, 90, 127]);
  engine.irig([0xb1, 90, 0]);
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
  engine.irig([0x90, 60, 100]);
  engine.irig([0xb0, 96, 64]);
  engine.irig([0xb0, 96, 127]);
  engine.irig([0xb0, 95, 50]);
  engine.irig([0xb0, 95, 55]);
  assert.deepEqual(sent.filter(({ destination }) => destination === 'opz').map(({ bytes }) => bytes),
    [[0xb0, 15, 50], [0xb0, 15, 55]]);
  assert.deepEqual(sent.filter(({ destination }) => destination === 'iac').map(({ bytes }) => bytes),
    [[0xb0, 16, 50], [0xb0, 16, 100], [0xb0, 15, 50], [0xb0, 15, 55]]);
  engine.irig([0x80, 60, 0]);
  engine.irig([0x90, 60, 100]);
  engine.irig([0xb0, 96, 64]);
  engine.irig([0x80, 60, 0]);
  engine.irig([0x90, 60, 100]);
  engine.irig([0xb0, 96, 127]);
  assert.equal(engine.mixer.levels[0], 100, 'fader retains the underlying level across pad releases');
  engine.irig([0x80, 60, 0]);
  engine.irig([0x91, 60, 100]);
  sent.length = 0;
  engine.irig([0xb0, 96, 60]);
  assert.equal(sent.filter(({ destination }) => destination === 'opz' || destination === 'iac').length, 0, 'unknown level is not guessed');
});

test('mixer pots set absolute values on all held tracks, even before feedback', () => {
  const sent = [];
  const engine = new Engine({ send: (destination, bytes) => { sent.push({ destination, bytes }); return true; }, changed: () => {}, save: () => {} });
  engine.opz([0xb0, 16, 100]);
  engine.irig([0x90, 60, 100]);
  engine.irig([0x91, 60, 100]);
  engine.irig([0xb0, 96, 64]);
  sent.length = 0;
  engine.irig([0xb0, 94, 80]);
  engine.irig([0xb0, 95, 0]);
  assert.deepEqual(sent.filter(({ destination }) => destination === 'opz').map(({ bytes }) => bytes),
    [[0xb0, 16, 80], [0xb1, 16, 80], [0xb0, 15, 0], [0xb1, 15, 0]]);
  assert.deepEqual(sent.filter(({ destination }) => destination === 'iac').map(({ bytes }) => bytes),
    [[0xb0, 16, 40], [0xb1, 16, 80], [0xb0, 15, 0], [0xb1, 15, 0]]);
  engine.irig([0xb0, 96, 127]);
  assert.deepEqual(engine.mixer.levels.slice(0, 2), [80, 80], 'pot 1 establishes the new fader baseline');
  engine.irig([0xb0, 94, 127]);
  engine.irig([0xb0, 95, 127]);
  assert.deepEqual(engine.mixer.levels.slice(0, 2), [127, 127]);
  assert.deepEqual(engine.mixer.pans.slice(0, 2), [127, 127]);
});

test('mixer LEDs show each track fader scale while retaining the underlying level', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let canSend = true;
  const engine = new Engine({ send: (destination) => destination !== 'iac' || canSend, changed: () => {}, save: () => {} });
  engine.opz([0xb0, 16, 100]);
  engine.opz([0xb1, 16, 40]);
  engine.irig([0x90, 60, 100]);
  engine.irig([0x91, 60, 100]);
  engine.irig([0xb0, 96, 64]);
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
  engine.irig([0xb0, 96, 0]);
  assert.deepEqual(engine.leds()[0], [34, 21], 'failed sends do not change the scale');
  canSend = true;
  engine.irig([0xb0, 96, 0]);
  assert.deepEqual(engine.leds().slice(0, 2), [[7, 5], [7, 5]], 'zero fader scale leaves active pads visible');
  engine.irig([0xb0, 94, 80]);
  assert.deepEqual(engine.mixer.baseLevels.slice(0, 2), [80, 80]);
  engine.irig([0x80, 60, 0]);
  engine.irig([0x81, 60, 0]);
  assert.deepEqual(engine.leds().slice(0, 2), [[7, 5], [7, 5]], 'pot 1 preserves the scale');
  assert.deepEqual(engine.mixer.levels.slice(0, 2), [0, 0]);
  engine.irig([0x90, 60, 100]);
  engine.irig([0x91, 60, 100]);
  engine.irig([0xb0, 96, 64]);
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
  engine.irig([0x90, 60, 100]);
  engine.irig([0x91, 60, 100]);
  sent.length = 0;
  engine.irig([0xb0, 94, 80]);
  assert.deepEqual(engine.leds().slice(0, 4), [[0, 80], [0, 80], [0, 30], [0, 0]]);
  assert.deepEqual(sent.filter(({ destination }) => destination === 'opz').map(({ bytes }) => bytes),
    [[0xb0, 16, 80], [0xb1, 16, 80]]);
  t.mock.timers.tick(999);
  sent.length = 0;
  engine.irig([0xb0, 95, 0]);
  assert.deepEqual(engine.leds().slice(0, 4), [[64, 0], [64, 0], [0, 127], [0, 0]]);
  assert.deepEqual(sent.filter(({ destination }) => destination === 'opz').map(({ bytes }) => bytes),
    [[0xb0, 15, 0], [0xb1, 15, 0]]);
  t.mock.timers.tick(5000);
  assert.deepEqual(engine.leds()[0], [64, 0], 'pot display persists while pads are held');
  engine.irig([0x92, 60, 100]);
  engine.irig([0x80, 60, 0]);
  engine.irig([0x81, 60, 0]);
  assert.deepEqual(engine.leds()[0], [64, 0], 'changing held pads preserves the display');
  engine.irig([0xb0, 96, 64]);
  assert.deepEqual(engine.leds()[0], [64, 0], 'fader movement preserves the pot display');
  engine.irig([0xb0, 91, 127]);
  engine.irig([0xb0, 94, 70]);
  assert.deepEqual(engine.leds()[0], [127, 35], 'mute-group display takes precedence');
  engine.irig([0xb0, 91, 0]);
  assert.deepEqual(engine.leds()[0], [0, 80], 'pot display returns while any pad is held');
  engine.irig([0x82, 60, 0]);
  assert.deepEqual(engine.leds()[0], [0, 127], 'releasing the last pad restores the usual display');
  engine.cancelReleaseLedRefreshes();
});

test('mixer fader display transitions to orange at half scale and dims toward zero', () => {
  const sent = [];
  const engine = new Engine({ send: (destination, bytes) => { sent.push({ destination, bytes }); return true; }, changed: () => {}, save: () => {} });
  engine.opz([0xb0, 16, 100]);
  engine.irig([0x90, 60, 100]);
  const colors = [];
  for (const scale of [0, 32, 63, 95, 127]) {
    sent.length = 0;
    engine.irig([0xb0, 96, scale]);
    colors.push(engine.leds()[0]);
    assert.deepEqual(sent.filter(({ destination }) => destination === 'irig').map(({ bytes }) => bytes),
      [[0xb0, 94, colors.at(-1)[1]], [0xb0, 95, colors.at(-1)[0]]]);
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
  engine.irig([0x90, 60, 100]);
  sent.length = 0;
  engine.irig([0xb0, 96, 64]);
  assert.deepEqual(sent.filter(({ destination }) => destination !== 'irig'), [{ destination: 'iac', bytes: [0xb0, 16, 50] }]);
  sent.length = 0;
  engine.irig([0xb0, 94, 80]);
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
  engine.irig([0xb0, 94, 10]);
  assert.deepEqual(engine.leds()[0], [0, 40]);
  assert.deepEqual(engine.leds()[1], [0, 0], 'unknown level is dark');
  engine.opz([0xb1, 15, 0]);
  t.mock.timers.tick(999);
  assert.deepEqual(engine.leds()[0], [0, 40]);
  engine.irig([0xb0, 95, 10]);
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
  engine.irig([0xb0, 94, 11]);
  engine.irig([0x90, 60, 100]);
  sent.length = 0;
  t.mock.timers.tick(1000);
  assert.equal(sent.length, 0, 'pad interaction cancels the display timeout');
  engine.irig([0x80, 60, 0]);
  engine.irig([0xb0, 94, 12]);
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
  engine.irig([0xb0, 95, 10]);
  assert.deepEqual(engine.leds().slice(0, 4), [[64, 0], [32, 64], [0, 127], [0, 0]]);
  assert(sent.some(({ destination, bytes }) => destination === 'irig' && bytes.join() === '176,95,64'), 'hard-left red is sent to the iRig');
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

test('button 2 highlights the selected mute group and dims the other groups', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent = [];
  let canSend = true;
  const engine = new Engine({ send: (destination, bytes) => { sent.push({ destination, bytes }); return destination !== 'opz' || canSend; }, changed: () => {}, save: () => {} });
  const groupLeds = (index) => Array.from({ length: 16 }, (_, pad) => pad === index ? [127, 35] : pad < 10 ? [7, 5] : [0, 0]);
  engine.opz([0xb0, 16, 50]);
  engine.irig([0xb0, 94, 10]);
  engine.irig([0xd1, 80]);
  sent.length = 0;
  engine.irig([0xb0, 91, 127]);
  assert.deepEqual(engine.leds(), groupLeds(0), 'group display overrides the pot display');
  assert.equal(sent.filter(({ destination }) => destination === 'irig').length, 32, 'button press refreshes even pending pressure LEDs');
  assert(sent.some(({ destination, bytes }) => destination === 'irig' && bytes.join() === '176,96,5'));
  assert(sent.some(({ destination, bytes }) => destination === 'irig' && bytes.join() === '176,97,7'));
  engine.irig([0x92, 60, 100]);
  assert.deepEqual(engine.leds(), groupLeds(2));
  engine.irig([0x82, 60, 0]);
  engine.irig([0x9a, 60, 100]);
  assert.deepEqual(engine.leds(), groupLeds(2), 'pads 11-16 do not select a group');
  engine.irig([0x8a, 60, 0]);
  canSend = false;
  engine.irig([0x93, 60, 100]);
  assert.deepEqual(engine.leds(), groupLeds(2), 'failed group selection keeps the current group');
  engine.irig([0x83, 60, 0]);
  engine.opz([0xb0, 55, 9]);
  assert.deepEqual(engine.leds(), groupLeds(9), 'incoming group changes update the display');
  t.mock.timers.tick(200);
  assert.deepEqual(engine.leds(), groupLeds(9), 'delayed release refreshes keep the group display');
  engine.irig([0xb0, 91, 0]);
  assert.deepEqual(engine.leds(), Array.from({ length: 16 }, () => [0, 127]), 'button release restores the track display');
});

test('mixer toggles unknown mute, sends channel-specific note stops, and tracks selected groups', () => {
  const sent = [];
  const engine = new Engine({ send: (destination, bytes) => { sent.push({ destination, bytes }); return true; }, changed: () => {}, save: () => {} });
  engine.irig([0xb0, 91, 127]);
  engine.irig([0x92, 60, 100]);
  assert.equal(engine.mixer.group, 2);
  assert.equal(engine.mixer.groups[2][1], null);
  assert(sent.some(({ destination, bytes }) => destination === 'opz' && bytes.join() === '176,55,2'));
  engine.irig([0x82, 60, 0]);
  engine.irig([0xb0, 91, 0]);
  engine.irig([0xb0, 90, 127]);
  sent.length = 0;
  engine.irig([0x91, 60, 100]);
  assert.equal(engine.mixer.groups[2][1], true);
  assert.deepEqual(sent.filter(({ destination }) => destination !== 'irig'), [
    { destination: 'opz', bytes: [0xb1, 53, 1] },
    { destination: 'iac', bytes: [0xb1, 120, 0] },
    { destination: 'iac', bytes: [0xb1, 123, 0] },
  ]);
  engine.irig([0x81, 60, 0]);
  engine.irig([0x91, 60, 100]);
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
  engine.irig([0x90, 60, 100]);
  engine.irig([0xb0, 94, 64]);
  assert.equal(engine.mixer.levels[0], 100);
  assert.equal(sent.filter(({ destination, bytes }) => destination === 'iac' && bytes[1] === 16).length, 1);
  engine.irig([0x80, 60, 0]);
  engine.irig([0xb0, 90, 127]);
  engine.irig([0x90, 60, 100]);
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
  sent.length = 0;
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
    [0xb0, 94, 0], [0xb0, 95, 50],
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
  for (const data of [[0x90, 60, 100], [0xd0, 64], [0x90, 60, 100], [0x80, 60, 0], [0x80, 60, 0]]) engine.irig(data);
  assert.deepEqual(sent.filter(({ destination }) => destination === 'irig').map(({ bytes }) => bytes),
    Array.from({ length: 4 }, () => [[0xb0, 94, 127], [0xb0, 95, 0]]).flat());
  engine.cancelReleaseLedRefreshes();
  engine.releaseAll();
});

test('pad release reconciles the latest LED state after the iRig changes it', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent = [];
  const engine = new Engine({ send: (destination, bytes) => { sent.push({ destination, bytes }); return true; }, changed: () => {}, save: () => {} });
  engine.opz([0xb0, 53, 0]);
  engine.irig([0x90, 60, 100]);
  engine.irig([0xb0, 94, 80]);
  sent.length = 0;
  engine.irig([0x80, 60, 0]);
  const leds = () => sent.filter(({ destination, bytes }) => destination === 'irig' && (bytes[1] === 94 || bytes[1] === 95)).map(({ bytes }) => bytes);
  assert.deepEqual(leds(), [[0xb0, 94, 127], [0xb0, 95, 0]], 'release refreshes immediately');
  t.mock.timers.tick(199);
  assert.equal(leds().length, 2);
  engine.opz([0xb0, 53, 1]);
  sent.length = 0;
  t.mock.timers.tick(1);
  assert.deepEqual(leds(), [[0xb0, 94, 0], [0xb0, 95, 0]], 'delayed refresh uses current state');
  engine.irig([0x90, 60, 100]);
  engine.irig([0x80, 60, 0]);
  engine.irig([0x90, 60, 100]);
  sent.length = 0;
  t.mock.timers.tick(200);
  assert.deepEqual(leds(), [[0xb0, 94, 0], [0xb0, 95, 0]], 'another press does not cancel the release refresh');
  engine.irig([0x80, 60, 0]);
  engine.releaseAll();
  sent.length = 0;
  t.mock.timers.tick(200);
  assert.deepEqual(leds(), [[0xb0, 94, 0], [0xb0, 95, 0]], 'releaseAll does not cancel the release refresh');
});

test('every rapid pad release refreshes the current state after 200ms, including button-modified taps', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent = [];
  const engine = new Engine({ send: (destination, bytes) => { sent.push({ destination, bytes }); return true; }, changed: () => {}, save: () => {} });
  engine.opz([0xb9, 53, 1]);
  engine.irig([0xb0, 90, 127]);
  engine.irig([0x99, 60, 100]);
  engine.irig([0x89, 60, 0]);
  t.mock.timers.tick(50);
  engine.irig([0x99, 60, 100]);
  engine.irig([0x89, 60, 0]);
  engine.irig([0xb0, 90, 0]);
  sent.length = 0;
  t.mock.timers.tick(149);
  assert.equal(sent.filter(({ destination }) => destination === 'irig').length, 0);
  t.mock.timers.tick(1);
  assert.deepEqual(sent.filter(({ destination }) => destination === 'irig').map(({ bytes }) => bytes),
    [[0xb0, 80, 0], [0xb0, 81, 0]], 'first release refreshes latest muted state');
  engine.opz([0xb9, 53, 0]);
  sent.length = 0;
  t.mock.timers.tick(50);
  assert.deepEqual(sent.filter(({ destination }) => destination === 'irig').map(({ bytes }) => bytes),
    [[0xb0, 80, 127], [0xb0, 81, 0]], 'second release refreshes the new active state');
  engine.irig([0x89, 60, 0]);
  engine.selectScene(1);
  sent.length = 0;
  t.mock.timers.tick(200);
  assert.deepEqual(sent.filter(({ destination }) => destination === 'irig').map(({ bytes }) => bytes),
    [[0xb0, 80, 0], [0xb0, 81, 0]], 'scene change still refreshes the new scene state');
  engine.irig([0x89, 60, 0]);
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
  engine.irig([0x90, 60, 10]);
  engine.irig([0x91, 60, 20]);
  sent.length = 0;
  for (const value of [30, 40, 50]) engine.irig([0xd0, value]);
  engine.irig([0xd1, 60]);
  engine.opz([0xb0, 15, 10]);
  assert.equal(sent.filter(({ destination }) => destination === 'irig').length, 0);
  t.mock.timers.tick(49);
  assert.equal(sent.filter(({ destination }) => destination === 'irig').length, 0);
  t.mock.timers.tick(1);
  const leds = () => sent.filter(({ destination }) => destination === 'irig').map(({ bytes }) => bytes);
  assert.deepEqual(leds(), [[0xb0, 94, 0], [0xb0, 95, 50], [0xb0, 96, 0], [0xb0, 97, 60]]);
  sent.length = 0;
  engine.irig([0xd0, 51]);
  t.mock.timers.tick(25);
  engine.irig([0xd0, 52]);
  t.mock.timers.tick(24);
  assert.equal(leds().length, 0, 'continuous pressure stays rate-limited');
  t.mock.timers.tick(1);
  assert.deepEqual(leds(), [[0xb0, 94, 0], [0xb0, 95, 52]], 'latest pressure is sent on the next interval');
  sent.length = 0;
  engine.irig([0xd0, 70]);
  engine.irig([0xd0, 80]);
  engine.irig([0x80, 60, 0]);
  assert.deepEqual(leds(), [[0xb0, 94, 0], [0xb0, 95, 0]], 'release restores LEDs immediately');
  t.mock.timers.tick(50);
  assert.equal(leds().length, 2, 'release cancels the queued pressure refresh');
  engine.cancelReleaseLedRefreshes();
  engine.irig([0xd1, 90]);
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
