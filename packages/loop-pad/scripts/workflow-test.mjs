#!/usr/bin/env node
// Workflow test: validates the full MIDI-driven record → play → mixer →
// delete → project-switch cycle without any real MIDI or audio hardware.
//
// Web MIDI's requestMIDIAccess() (non-sysex) needs no permission grant in
// Chrome, and window.__loopPadTest.noteOn/noteOff/cc/clock/start/stop drive
// the sampler's MIDI handling directly, so this only needs a fake mic
// device — no persistent profile or one-time hardware setup required
// (contrast with Tape's scripts/hardware-test.mjs).
//
// Prerequisites:
//   1. npm run dev:loop-pad   (dev server must be running)
//
// Run:
//   npm run test:workflow --workspace=loop-pad

import { chromium } from 'playwright';

const APP_URL = process.env.LOOP_PAD_URL ?? 'http://localhost:5173/tape/loop-pad/';
const TIMEOUT_MS = 20_000;

async function waitFor(page, predicate, timeoutMs = TIMEOUT_MS, label = '(condition)') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const result = await page.evaluate(predicate);
      if (result) return result;
    } catch { /* not yet */ }
    await page.waitForTimeout(200);
  }
  throw new Error(`Timeout waiting for: ${label}`);
}

let passed = 0;
let failed = 0;

function assert(condition, label, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

function assertEq(actual, expected, label) {
  assert(actual === expected, label, `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

(async () => {
  const browser = await chromium.launch({
    headless: false,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  });
  const page = await browser.newPage();
  console.log('\n=== Loop Pad Workflow Test ===\n');

  try {
    console.log('1. Navigate and enable audio…');
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    const initBtn = page.locator('button', { hasText: 'Enable Audio' });
    if (await initBtn.isVisible({ timeout: 3000 }).catch(() => false)) await initBtn.click();

    await waitFor(page, () => window.__loopPadTest?.getState()?.ready === true, TIMEOUT_MS, 'app ready');
    const initState = await page.evaluate(() => window.__loopPadTest.getState());
    assert(initState.ready, 'App initialised');
    const firstNote = initState.settings.firstSampleNote;
    const deleteNote = initState.settings.deleteNote;
    const countInOnNote = initState.settings.countInOnNote;
    const countInOffNote = initState.settings.countInOffNote;
    console.log(`   Ready. First sample note=${firstNote}, delete note=${deleteNote}, count-in on=${countInOnNote}, count-in off=${countInOffNote}`);
    assertEq(deleteNote, 76, 'Delete/reset note defaults to 76');
    assertEq(countInOnNote, 74, 'Count-in On note defaults to 74');
    assertEq(countInOffNote, 72, 'Count-in Off note defaults to 72');
    assertEq(initState.settings.recordingTailMs, 300, 'Recording tail defaults to 300 ms');

    console.log('\n2. Empty slots ignore Note On while stopped…');
    await page.evaluate((note) => window.__loopPadTest.noteOn(note), firstNote);
    let state = await page.evaluate(() => window.__loopPadTest.getState());
    assertEq(state.slots[0].state, 'empty', 'Slot 0 remains empty while stopped');

    console.log('\n3. Record into slot 0 while running…');
    await page.evaluate(() => window.__loopPadTest.start());
    state = await waitFor(page, () => {
      const st = window.__loopPadTest.getState();
      return st.clockRunning ? st : null;
    }, TIMEOUT_MS, 'sequencer running');
    assert(state.clockRunning, 'Sequencer running after Start');
    await page.evaluate((note) => window.__loopPadTest.noteOn(note), firstNote);
    state = await page.evaluate(() => window.__loopPadTest.getState());
    assertEq(state.slots[0].state, 'recording', 'Slot 0 recording after Note On');

    await page.waitForTimeout(400); // let the worklet accumulate some samples
    await page.evaluate((note) => window.__loopPadTest.noteOff(note), firstNote);
    await page.evaluate((note) => window.__loopPadTest.noteOn(note), firstNote);
    state = await waitFor(page, () => {
      const st = window.__loopPadTest.getState();
      return st.slots[0].isPlaying ? st : null;
    }, TIMEOUT_MS, 'recording-tail preview playing');
    assertEq(state.slots[0].state, 'recording', 'Slot 0 keeps recording while its tail preview plays');
    assert(state.slots[0].isPlaying, 'Next pattern Note On plays the capture before its recording tail flushes');
    state = await waitFor(page, () => {
      const st = window.__loopPadTest.getState();
      return st.slots[0].state === 'stopped' ? st : null;
    }, TIMEOUT_MS, 'slot 0 finished recording');
    assertEq(state.slots[0].state, 'stopped', 'Slot 0 stopped after Note Off');
    assert(state.slots[0].hasSample, 'Slot 0 has a stored sample');
    assertEq(state.slots[0].sampleChannels, 2, 'Slot 0 retains a stereo sample');
    assert(state.slots[0].durationSecs >= 0.6, 'Slot 0 sample includes the 300 ms recording tail', `got ${state.slots[0].durationSecs}s`);

    console.log('\n4. Recording selects the slot and mixer CC keeps that selection…');
    assertEq(state.selectedSlot, 0, 'Completed recording selects slot 0');
    await page.evaluate((cc) => window.__loopPadTest.cc(cc, 64), state.settings.panCc);
    state = await page.evaluate(() => window.__loopPadTest.getState());
    assertEq(Math.round(state.slots[0].mixer.pan * 100) / 100, Math.round(((64 / 127) * 2 - 1) * 100) / 100, 'Slot 0 pan updated by CC');
    assertEq(state.selectedSlot, 0, 'CC adjustment keeps slot 0 selected');
    assertEq(state.settings.masterLevelCc, 16, 'Master level CC defaults to 16');
    await page.evaluate((cc) => window.__loopPadTest.cc(cc, 64), state.settings.masterLevelCc);
    state = await waitFor(page, () => {
      const st = window.__loopPadTest.getState();
      return st.settings.masterLevel === 64 / 127 ? st : null;
    }, TIMEOUT_MS, 'master level updated by CC');
    assertEq(state.settings.masterLevel, 64 / 127, 'Master level updated by CC');

    console.log('\n5. Sequencer Stop stops playback immediately…');
    await page.evaluate((note) => window.__loopPadTest.noteOn(note), firstNote);
    state = await page.evaluate(() => window.__loopPadTest.getState());
    assertEq(state.slots[0].state, 'playing', 'Slot 0 playing after re-trigger');
    await page.evaluate(() => window.__loopPadTest.stop());
    state = await page.evaluate(() => window.__loopPadTest.getState());
    assertEq(state.slots[0].state, 'stopped', 'Slot 0 stopped after sequencer Stop');

    console.log('\n6. Playback: retrigger, then stop by Note Off…');
    await page.evaluate(() => window.__loopPadTest.start());
    await page.evaluate((note) => window.__loopPadTest.noteOn(note), firstNote);
    state = await page.evaluate(() => window.__loopPadTest.getState());
    assertEq(state.slots[0].state, 'playing', 'Slot 0 playing after re-trigger');
    await page.evaluate((note) => window.__loopPadTest.noteOff(note), firstNote);
    state = await waitFor(page, () => {
      const st = window.__loopPadTest.getState();
      return st.slots[0].state === 'stopped' ? st : null;
    }, TIMEOUT_MS, 'slot 0 stopped after Note Off');
    assertEq(state.slots[0].state, 'stopped', 'Slot 0 stopped after Note Off');

    console.log('\n7. Delete via sample-note + delete-note within 500ms…');
    await page.evaluate((note) => window.__loopPadTest.noteOn(note), firstNote);
    await page.evaluate((note) => window.__loopPadTest.noteOn(note), deleteNote);
    state = await waitFor(page, () => {
      const st = window.__loopPadTest.getState();
      return st.slots[0].state === 'empty' ? st : null;
    }, 2000, 'slot 0 cleared by delete');
    assertEq(state.slots[0].state, 'empty', 'Slot 0 empty after delete');
    assert(!state.slots[0].hasSample, 'Slot 0 has no sample after delete');

    console.log('\n8. A zero recording tail stops capture immediately…');
    await page.evaluate(() => window.__loopPadTest.updateSettings({ recordingTailMs: 0 }));
    await page.evaluate((note) => window.__loopPadTest.noteOn(note), firstNote + 1);
    await page.waitForTimeout(400);
    await page.evaluate((note) => window.__loopPadTest.noteOff(note), firstNote + 1);
    state = await waitFor(page, () => {
      const st = window.__loopPadTest.getState();
      return st.slots[1].state === 'stopped' && st.selectedSlot === 1 ? st : null;
    }, TIMEOUT_MS, 'slot 1 finished recording and selected');
    assertEq(state.selectedSlot, 1, 'Completed recording selects slot 1');
    assert(state.slots[1].durationSecs < 0.55, 'Zero recording tail adds no capture duration', `got ${state.slots[1].durationSecs}s`);

    console.log('\n9. Standalone Reset clears the selected slot while running…');
    await page.evaluate((note) => window.__loopPadTest.noteOn(note), deleteNote);
    state = await waitFor(page, () => {
      const st = window.__loopPadTest.getState();
      return st.slots[1].state === 'empty' ? st : null;
    }, TIMEOUT_MS, 'selected slot cleared by standalone Reset');
    assertEq(state.slots[1].state, 'empty', 'Standalone Reset clears selected slot while running');
    assertEq(state.selectedSlot, null, 'Reset clears the selection after deleting its slot');

    console.log('\n10. Project switch resets the visible slots…');
    await page.evaluate(() => window.__loopPadTest.selectProject(2));
    state = await waitFor(page, () => {
      const st = window.__loopPadTest.getState();
      return st.projectIndex === 2 ? st : null;
    }, TIMEOUT_MS, 'project switched to 2');
    assertEq(state.projectIndex, 2, 'Project index is 2');
    assert(state.slots.every((s) => s.state === 'empty'), 'Fresh project has all-empty slots');
    await page.evaluate(() => window.__loopPadTest.selectProject(1));

    console.log('\n11. Count-in turns on and off from dedicated channel-16 MIDI notes…');
    await page.evaluate(([note, channel]) => window.__loopPadTest.noteOn(note, 100, channel), [countInOnNote, 14]);
    state = await page.evaluate(() => window.__loopPadTest.getState());
    assertEq(state.settings.countInEnabled, false, 'Count-in ignores its On note on another channel');
    await page.evaluate((note) => window.__loopPadTest.noteOn(note), countInOnNote);
    state = await waitFor(page, () => {
      const st = window.__loopPadTest.getState();
      return st.settings.countInEnabled ? st : null;
    }, TIMEOUT_MS, 'count-in enabled by MIDI On note');
    assert(state.settings.countInEnabled, 'Count-in enabled by MIDI On note');
    await page.evaluate((note) => window.__loopPadTest.noteOn(note), countInOffNote);
    state = await waitFor(page, () => {
      const st = window.__loopPadTest.getState();
      return !st.settings.countInEnabled ? st : null;
    }, TIMEOUT_MS, 'count-in disabled by MIDI Off note');
    assertEq(state.settings.countInEnabled, false, 'Count-in disabled by MIDI Off note');
    await page.evaluate((note) => window.__loopPadTest.noteOn(note), countInOnNote);

    console.log('\n12. Count-in: Start intercepted, then re-Start after N beats of clock…');
    await page.evaluate(() => window.__loopPadTest.updateSettings({ countInBeats: 2 }));
    await waitFor(page, () => window.__loopPadTest.getState().settings.countInEnabled === true, TIMEOUT_MS, 'count-in enabled');
    await page.evaluate(() => window.__loopPadTest.start());
    state = await waitFor(page, () => {
      const st = window.__loopPadTest.getState();
      return st.countInCounting ? st : null;
    }, TIMEOUT_MS, 'count-in counting after Start');
    assert(state.countInCounting, 'Count-in counting after Start');
    let transportEvents = await page.evaluate(() => window.__loopPadTest.sentTransportEvents());
    assertEq(transportEvents.at(-1), 'stop', 'Count-in immediately sends Stop to the OP-Z');
    await page.evaluate((note) => {
      window.__loopPadTest.noteOn(note);
      window.__loopPadTest.noteOff(note);
    }, firstNote + 1);
    state = await page.evaluate(() => window.__loopPadTest.getState());
    assertEq(state.slots[1].state, 'empty', 'Slot notes during count-in do not record');
    await page.evaluate(() => window.__loopPadTest.stop());
    state = await page.evaluate(() => window.__loopPadTest.getState());
    assert(state.countInCounting, 'Echoed Stop does not cancel the count-in');
    for (let i = 0; i < 2 * 24; i++) {
      await page.evaluate(() => window.__loopPadTest.clock());
    }
    state = await waitFor(page, () => {
      const st = window.__loopPadTest.getState();
      return !st.countInCounting ? st : null;
    }, TIMEOUT_MS, 'count-in finished');
    assert(!state.countInCounting, 'Count-in finished after the configured beat count');
    transportEvents = await page.evaluate(() => window.__loopPadTest.sentTransportEvents());
    assertEq(transportEvents.at(-1), 'start', 'Count-in sends Start to the OP-Z after the final beat');
    await page.evaluate(() => window.__loopPadTest.start());
    state = await page.evaluate(() => window.__loopPadTest.getState());
    assert(!state.countInCounting, 'Echoed Start does not begin another count-in');
    await page.evaluate((note) => window.__loopPadTest.noteOn(note), firstNote + 1);
    state = await page.evaluate(() => window.__loopPadTest.getState());
    assertEq(state.slots[1].state, 'recording', 'Slot notes record after the synthetic Start echo');
    await page.evaluate((note) => window.__loopPadTest.noteOff(note), firstNote + 1);
    await waitFor(page, () => {
      const st = window.__loopPadTest.getState();
      return st.slots[1].state === 'stopped' ? st : null;
    }, TIMEOUT_MS, 'slot 1 recording finished after count-in');

    console.log('\n11. BPM: stabilize after two beats of timestamped MIDI Clock…');
    const bpm = 120;
    const clockIntervalMs = 60_000 / (bpm * 24);
    const firstClockTime = performance.now();
    await page.evaluate(() => window.__loopPadTest.start());
    for (let index = 0; index < 47; index++) {
      await page.evaluate((timeStamp) => window.__loopPadTest.clock(timeStamp), firstClockTime + index * clockIntervalMs);
    }
    state = await page.evaluate(() => window.__loopPadTest.getState());
    assertEq(state.bpm, bpm, 'BPM remains visible while count-in intercepts Start');
    await page.evaluate((timeStamp) => window.__loopPadTest.clock(timeStamp), firstClockTime + 47 * clockIntervalMs);
    state = await waitFor(page, () => {
      const st = window.__loopPadTest.getState();
      return st.bpm === 120 ? st : null;
    }, TIMEOUT_MS, '120 BPM after stable MIDI Clock');
    assertEq(state.bpm, bpm, 'BPM derives from MIDI timestamps');
    const countInButton = page.getByRole('button', { name: 'Count-in' });
    assert(await countInButton.isEnabled(), 'Front-panel Count-in button enables after tempo is measured');
    await countInButton.click();
    state = await waitFor(page, () => {
      const st = window.__loopPadTest.getState();
      return st.countInCounting ? st : null;
    }, TIMEOUT_MS, 'manual count-in started');
    assert(state.countInCounting, 'Front-panel Count-in starts the transport procedure');
    state = await waitFor(page, () => {
      const st = window.__loopPadTest.getState();
      return !st.countInCounting ? st : null;
    }, TIMEOUT_MS, 'manual count-in finished without incoming Clock');
    assert(!state.countInCounting, 'Manual count-in restarts transport using the measured tempo');
    await page.evaluate(() => window.__loopPadTest.stop());
    state = await waitFor(page, () => {
      const st = window.__loopPadTest.getState();
      return st.bpm === null ? st : null;
    }, TIMEOUT_MS, 'BPM cleared on Stop');
    assertEq(state.bpm, null, 'BPM clears on Stop');

    console.log('\n12. Invalid project recovery clears only project memory…');
    await page.evaluate(async () => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('loop-pad-projects');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise((resolve, reject) => {
        const transaction = db.transaction('projects', 'readwrite');
        transaction.objectStore('projects').put({
          name: 'project-01', savedAt: Date.now(), bytes: new Uint8Array([0, 0, 0, 0]),
        });
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
      db.close();
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitFor(page, () => document.body.innerText.includes('Not a valid Loop Pad project file'), TIMEOUT_MS, 'invalid project error');
    page.once('dialog', (dialog) => void dialog.accept());
    await page.getByRole('button', { name: 'Clear Project Memory' }).click();
    state = await waitFor(page, () => {
      const st = window.__loopPadTest.getState();
      return st.ready ? st : null;
    }, TIMEOUT_MS, 'app ready after clearing project memory');
    assert(state.ready, 'Clearing invalid project memory restores startup');
    assert(state.slots.every((slot) => slot.state === 'empty'), 'Cleared project memory starts with empty slots');
  } catch (err) {
    console.error('\nFatal error:', err);
    failed++;
  } finally {
    await browser.close();
  }

  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
