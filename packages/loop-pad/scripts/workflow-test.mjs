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
import { readFile } from 'node:fs/promises';

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
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  });
  const context = await browser.newContext();
  await context.grantPermissions(['microphone'], { origin: new URL(APP_URL).origin });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'requestMIDIAccess', {
      configurable: true,
      value: async () => ({ inputs: new Map(), outputs: new Map() }),
    });
  });
  const page = await context.newPage();
  console.log('\n=== Loop Pad Workflow Test ===\n');

  try {
    console.log('1. Navigate and enable audio…');
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    const initBtn = page.locator('button', { hasText: 'Enable Audio' });
    if (await initBtn.isVisible({ timeout: 3000 }).catch(() => false)) await initBtn.click();

    let initState = await waitFor(page, () => {
      const state = window.__loopPadTest?.getState();
      return state?.ready || state?.error ? state : null;
    }, TIMEOUT_MS, 'app ready or project error');
    if (initState.error) {
      page.once('dialog', (dialog) => void dialog.accept());
      await page.getByRole('button', { name: 'Clear Project Memory' }).click();
      initState = await waitFor(page, () => {
        const state = window.__loopPadTest?.getState();
        return state?.ready ? state : null;
      }, TIMEOUT_MS, 'app ready after startup project recovery');
    }
    assert(initState.ready, 'App initialised');
    const projectButton = page.getByRole('button', { name: 'Project 01' });
    assertEq(await page.getByRole('button', { name: 'Count-in', exact: true }).count(), 0, 'Count-in is a MIDI-controlled status, not a button');
    assertEq(await page.getByRole('dialog', { name: 'Project options' }).count(), 0, 'Project pane is initially closed');
    await projectButton.click();
    const projectPane = page.getByRole('dialog', { name: 'Project options' });
    assert(await projectPane.isVisible(), 'Project button opens the project pane');
    assertEq(await projectPane.getByLabel('Project').locator('option').count(), 10, 'Project pane provides all ten projects');
    assertEq(await projectPane.getByRole('button').count(), 3, 'Project pane contains initialize, download and restore');
    page.once('dialog', (dialog) => void dialog.dismiss());
    await projectPane.getByRole('button', { name: 'Initialize' }).click();
    assert(await projectPane.isVisible(), 'Canceling initialization leaves the project pane open');
    await page.keyboard.press('Escape');
    assertEq(await projectPane.count(), 0, 'Escape closes the project pane');
    assert(await projectButton.evaluate((button) => document.activeElement === button), 'Escape returns focus to the project button');
    await projectButton.click();
    await page.locator('.sample-waveform').click({ position: { x: 5, y: 5 } });
    assertEq(await projectPane.count(), 0, 'Clicking outside closes the project pane');
    assertEq(await page.locator('.slots [data-slot-index]').count(), 16, 'Front panel displays all 16 slots');
    assertEq(await page.locator('.key-position-white').count(), 14, 'Keyboard displays 14 white keys');
    assertEq(await page.locator('.key-position-black').count(), 10, 'Keyboard displays 10 black keys');
    assertEq(await page.locator('.filter-meter span').textContent(), 'FILTER', 'Filter display uses its compact label');
    assertEq(await page.locator('.mixer-meter').first().locator('span').textContent(), 'LEVEL', 'Level display uses its full label');
    assertEq(
      await page.locator('.slot-black[data-slot-index]').evaluateAll((slots) => slots.map((slot) => Number(slot.dataset.slotIndex)).join(',')),
      '1,3,5,8,10,13,15',
      'Sample slots follow chromatic order across white and black keys',
    );
    assertEq(
      await page.locator('.key-callout-label').evaluateAll((labels) => labels.map((label) => Number(label.dataset.roleNote)).sort((a, b) => a - b).join(',')),
      '71,72,73,74,75,76',
      'Callouts identify the six configured control notes',
    );
    await page.evaluate(() => window.__loopPadTest.updateSettings({ channelSwitchNote: 69 }));
    await page.locator('.key-callouts-bottom [data-role-note="69"]').waitFor();
    assertEq(await page.locator('.key-callouts-top [data-role-note="73"]').count(), 0, 'Reassigned control moves to its configured white key');
    await page.evaluate(() => window.__loopPadTest.updateSettings({ channelSwitchNote: 77 }));
    await page.getByText('CHANNEL: MIDI 77 (outside shown keys)').waitFor();
    assertEq(await page.locator('[data-role-note="77"]').count(), 0, 'An off-keyboard assignment is not attached to the wrong key');
    await page.evaluate(() => window.__loopPadTest.updateSettings({ channelSwitchNote: 73 }));
    await page.locator('.key-callouts-top [data-role-note="73"]').waitFor();
    assertEq(await page.locator('[aria-label="No selected sample waveform"]').count(), 1, 'No waveform is selected at startup');
    const originalViewport = page.viewportSize();
    await page.setViewportSize({ width: 700, height: 940 });
    await page.waitForFunction(() => [...document.querySelectorAll('.key-callouts')].every((group) => {
      const svg = group.querySelector('svg');
      return svg && Math.abs(svg.viewBox.baseVal.width - group.getBoundingClientRect().width) < 1;
    }));
    const compactLayout = await page.evaluate(() => {
      const visible = (element) => {
        const rect = element.getBoundingClientRect();
        return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight;
      };
      return {
        fits: document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight,
        slots: [...document.querySelectorAll('.slots .slot')].every(visible),
        meters: [...document.querySelectorAll('.level-meter')].every(visible),
        toolbar: [...document.querySelectorAll('.panel-toolbar button, .panel-toolbar select, .panel-toolbar .toolbar-status')].every(visible),
        toolbarRows: new Set([...document.querySelectorAll('.panel-toolbar button, .panel-toolbar select, .panel-toolbar .toolbar-status')].map((element) => element.getBoundingClientRect().top)).size,
        centeredMeters: [...document.querySelectorAll('.level-meter')].every((meter) => {
          const outer = meter.getBoundingClientRect();
          const bars = meter.querySelector('.meter-bars').getBoundingClientRect();
          return Math.abs((outer.left + outer.right) / 2 - (bars.left + bars.right) / 2) < 1;
        }),
        alignedCallouts: [...document.querySelectorAll('.key-callouts')].every((group) => {
          const boxes = [...group.querySelectorAll('.key-callout-label')].map((label) => label.getBoundingClientRect());
          return new Set(boxes.map((box) => box.top)).size <= 1
            && boxes.every((box, index) => box.left >= 0 && box.right <= innerWidth
              && (index === 0 || boxes[index - 1].right <= box.left));
        }),
        equalMixerWidths: new Set([...document.querySelectorAll('.mixer-meter')].map((meter) => meter.getBoundingClientRect().width)).size === 1,
        inverseMixerLabels: [...document.querySelectorAll('.mixer-meter')].every((meter) => {
          const label = meter.querySelector('span');
          const fill = meter.querySelector('i');
          const rect = meter.getBoundingClientRect();
          const text = label.getBoundingClientRect();
          return getComputedStyle(label).mixBlendMode === 'difference'
            && getComputedStyle(meter).backgroundColor === 'rgb(0, 0, 0)'
            && getComputedStyle(fill).backgroundColor === 'rgb(255, 255, 255)'
            && Math.abs((rect.left + rect.right - text.left - text.right) / 2) < 1;
        }),
        keyFacesFit: [...document.querySelectorAll('.key-position .slot')].every((slot) => {
          const face = slot.querySelector('.slot-face').getBoundingClientRect();
          return Math.abs(face.width / slot.getBoundingClientRect().width - 0.5) < 0.01;
        }),
        flatHeader: [...document.querySelectorAll('.panel-toolbar, .panel-toolbar button, .panel-toolbar select, .panel-toolbar .toolbar-status, .clock-light')].every((element) => {
          const style = getComputedStyle(element);
          return style.backgroundImage === 'none' && style.boxShadow === 'none';
        }),
      };
    });
    assert(compactLayout.fits, '700px panel fits without scrolling');
    assert(compactLayout.slots && compactLayout.meters && compactLayout.toolbar, 'All slots, meters, and toolbar items fit at 700px');
    assertEq(compactLayout.toolbarRows, 1, 'Toolbar fits in one row at 700px');
    assert(compactLayout.centeredMeters, 'Both meters are centered in their side margins');
    assert(compactLayout.alignedCallouts, 'Callouts share a baseline without overlapping at 700px');
    assert(compactLayout.equalMixerWidths, 'Level, pan and filter displays have equal widths');
    assert(compactLayout.inverseMixerLabels, 'Mixer labels are centered and invert over black-and-white fills');
    assert(compactLayout.keyFacesFit, 'Key faces leave room for their waveform rings');
    assert(compactLayout.flatHeader, 'Header controls and indicators use flat styling');
    await projectButton.click();
    const paneBox = await projectPane.boundingBox();
    assert(paneBox && paneBox.x >= 0 && paneBox.x + paneBox.width <= 700, 'Project pane fits the 700px viewport');
    await page.keyboard.press('Escape');
    if (originalViewport) await page.setViewportSize(originalViewport);
    assertEq(
      await page.locator('.mixer-meter').evaluateAll((meters) => new Set(meters.map((meter) => meter.getBoundingClientRect().width)).size),
      1,
      'Mixer displays also have equal widths at the standard viewport',
    );
    const firstNote = initState.settings.firstSampleNote;
    const deleteNote = initState.settings.deleteNote;
    const countInOnNote = initState.settings.countInOnNote;
    const countInOffNote = initState.settings.countInOffNote;
    const channelSwitchNote = initState.settings.channelSwitchNote;
    const takeModeNote = initState.settings.takeModeNote;
    const oneShotModeNote = initState.settings.oneShotModeNote;
    console.log(`   Ready. First sample note=${firstNote}, delete note=${deleteNote}, count-in on=${countInOnNote}, count-in off=${countInOffNote}`);
    assertEq(deleteNote, 75, 'Delete/reset note defaults to 75');
    assertEq(countInOnNote, 72, 'Count-in On note defaults to 72');
    assertEq(countInOffNote, 71, 'Count-in Off note defaults to 71');
    assertEq(channelSwitchNote, 73, 'Channel Switch note defaults to 73');
    assertEq(takeModeNote, 76, 'Take Mode note defaults to 76');
    assertEq(oneShotModeNote, 74, 'One-shot Mode note defaults to 74');
    assertEq(initState.settings.recordingTailMs, 300, 'Recording tail defaults to 300 ms');
    assertEq(initState.settings.recordingLatencyMs, 20, 'Recording latency defaults to 20 ms');

    console.log('\n2. Empty slots flash on Note On while stopped…');
    const flashedSlots = await page.evaluate((note) => new Promise((resolve) => {
      const observer = new MutationObserver(() => {
        const count = document.querySelectorAll('[data-note-flashing="true"]').length;
        if (count > 0) {
          clearTimeout(timeout);
          observer.disconnect();
          resolve(count);
        }
      });
      const timeout = setTimeout(() => {
        observer.disconnect();
        resolve(0);
      }, 1000);
      observer.observe(document.querySelector('.slots'), { attributes: true, attributeFilter: ['data-note-flashing'], subtree: true });
      window.__loopPadTest.noteOn(note);
    }), firstNote);
    assertEq(flashedSlots, 1, 'Slot outline flashes on Note On even when no action is taken');
    let state = await page.evaluate(() => window.__loopPadTest.getState());
    assertEq(state.slots[0].state, 'empty', 'Slot 0 remains empty while stopped');
    await page.waitForTimeout(200);
    assertEq(await page.locator('[data-note-flashing="true"]').count(), 0, 'Slot outline flash clears promptly');

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
    assertEq(await page.locator('.slot-selected').count(), 1, 'Selected slot is highlighted');
    assertEq(await page.locator('[aria-label="Selected sample waveform"]').count(), 1, 'Selected sample waveform is displayed');
    const ringExtent = await page.locator('[data-slot-index="0"] canvas').evaluate((canvas) => {
      const { width, height } = canvas;
      const pixels = canvas.getContext('2d').getImageData(0, 0, width, height).data;
      const radii = [];
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          if (pixels[(y * width + x) * 4 + 3] > 0) radii.push(Math.hypot(x + 0.5 - width / 2, y + 0.5 - height / 2));
        }
      }
      return { min: Math.min(...radii) / width, max: Math.max(...radii) / width };
    });
    assert(ringExtent.min < 0.34 && ringExtent.max > 0.4, 'Sample waveform occupies the larger ring around each smaller key');
    const stripBox = await page.locator('.slot-strip').boundingBox();
    const waveformBox = await page.locator('.sample-waveform').boundingBox();
    assert(stripBox && waveformBox && waveformBox.y >= stripBox.y + stripBox.height, 'Selected waveform appears below the slot strip');
    await page.evaluate((cc) => window.__loopPadTest.cc(cc, 64), state.settings.levelCc);
    await waitFor(page, () => window.__loopPadTest.getState().slots[0].mixer.level === 64 / 127, TIMEOUT_MS, 'half-level mixer display');
    const levelScreenshot = await page.locator('.mixer-meter').first().screenshot();
    const inversePixels = await page.evaluate(async (png) => {
      const image = new Image();
      image.src = `data:image/png;base64,${png}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(image, 0, 0);
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let darkText = 0;
      let lightText = 0;
      for (let y = 3; y < canvas.height - 3; y++) {
        for (let x = 3; x < canvas.width - 3; x++) {
          const index = (y * canvas.width + x) * 4;
          const brightness = pixels[index] + pixels[index + 1] + pixels[index + 2];
          if (x < canvas.width * 0.48 && brightness < 120) darkText++;
          if (x > canvas.width * 0.52 && brightness > 600) lightText++;
        }
      }
      return darkText > 0 && lightText > 0;
    }, levelScreenshot.toString('base64'));
    assert(inversePixels, 'A partially filled mixer display renders dark and light text on opposite sides');
    await page.evaluate((cc) => window.__loopPadTest.cc(cc, 127), state.settings.levelCc);
    const panFill = page.locator('.mixer-meter').nth(1).locator('i');
    assertEq(await panFill.evaluate((fill) => fill.style.width), '0%', 'Centered pan has no fill');
    for (const [value, expectedLeft, expectedWidth] of [[0, 0, 50], [32, 32 / 127 * 100, 50 - 32 / 127 * 100], [96, 50, 96 / 127 * 100 - 50], [127, 50, 50]]) {
      await page.evaluate(([cc, value]) => window.__loopPadTest.cc(cc, value), [state.settings.panCc, value]);
      await page.waitForFunction(({ expectedLeft, expectedWidth }) => {
        const fill = document.querySelectorAll('.mixer-meter')[1].querySelector('i');
        return Math.abs(parseFloat(fill.style.left) - expectedLeft) < 0.01 && Math.abs(parseFloat(fill.style.width) - expectedWidth) < 0.01;
      }, { expectedLeft, expectedWidth }, { timeout: TIMEOUT_MS });
      assert(true, `Pan CC ${value} fills between center and the selected side`);
    }
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

    console.log('\n5. Channel Switch selects the sending MIDI channel bank and clears the selection…');
    await page.evaluate(() => window.__loopPadTest.stop());
    await waitFor(page, () => !window.__loopPadTest.getState().clockRunning, TIMEOUT_MS, 'sequencer stopped for channel selection');
    await page.evaluate(() => window.__loopPadTest.updateSettings({ channelMode: true }));
    await waitFor(page, () => window.__loopPadTest.getState().settings.channelMode, TIMEOUT_MS, 'channel mode enabled');
    await page.evaluate(([note, channel]) => window.__loopPadTest.noteOn(note, 100, channel), [firstNote, 14]);
    state = await waitFor(page, () => {
      const st = window.__loopPadTest.getState();
      return st.activeBank === 0 && st.selectedSlot === 0 ? st : null;
    }, TIMEOUT_MS, 'Channel A sample selected');
    assertEq(state.activeBank, 0, 'Channel A note selects Channel A');
    assertEq(state.selectedSlot, 0, 'Channel A note selects its slot');
    await page.evaluate(([note, channel]) => window.__loopPadTest.noteOn(note, 100, channel), [channelSwitchNote, 15]);
    state = await waitFor(page, () => {
      const st = window.__loopPadTest.getState();
      return st.activeBank === 1 && st.selectedSlot === null ? st : null;
    }, TIMEOUT_MS, 'Channel B Switch note selects Channel B and clears selection');
    assertEq(state.activeBank, 1, 'Channel Switch activates the bank mapped to its MIDI channel');
    assertEq(state.selectedSlot, null, 'Channel Switch clears the selected slot');
    await page.evaluate(([note, channel]) => window.__loopPadTest.noteOn(note, 100, channel), [deleteNote, 15]);
    await page.waitForTimeout(600);
    await page.evaluate(([note, channel]) => window.__loopPadTest.noteOn(note, 100, channel), [channelSwitchNote, 14]);
    state = await waitFor(page, () => {
      const st = window.__loopPadTest.getState();
      return st.activeBank === 0 ? st : null;
    }, TIMEOUT_MS, 'Channel A Switch note returns to Channel A');
    assert(state.slots[0].hasSample, 'Channel Switch cancels the prior bank’s pending sample-delete gesture');
    await page.evaluate(([note, channel]) => window.__loopPadTest.noteOn(note, 100, channel), [channelSwitchNote, 15]);
    state = await waitFor(page, () => {
      const st = window.__loopPadTest.getState();
      return st.activeBank === 1 ? st : null;
    }, TIMEOUT_MS, 'Channel B Switch note returns to Channel B');
    assertEq(state.activeBank, 1, 'Channel Switch selects the requested bank after changing channels');
    await page.evaluate(([note, channel]) => window.__loopPadTest.noteOn(note, 100, channel), [channelSwitchNote, 15]);
    state = await page.evaluate(() => window.__loopPadTest.getState());
    assertEq(state.activeBank, 1, 'Repeated Channel B Switch note does not toggle to Channel A');
    await page.evaluate(() => window.__loopPadTest.updateSettings({ channelMode: false }));
    await waitFor(page, () => !window.__loopPadTest.getState().settings.channelMode, TIMEOUT_MS, 'channel mode disabled');
    await page.evaluate((note) => window.__loopPadTest.noteOn(note), channelSwitchNote);
    state = await page.evaluate(() => window.__loopPadTest.getState());
    assertEq(state.activeBank, 1, 'Channel Switch does nothing while Channel Mode is off');
    assertEq(state.selectedSlot, null, 'Channel Switch preserves no selection while Channel Mode is off');
    await page.evaluate((note) => window.__loopPadTest.noteOn(note), firstNote);
    await waitFor(page, () => {
      const st = window.__loopPadTest.getState();
      return st.activeBank === 0 && st.selectedSlot === 0 ? st : null;
    }, TIMEOUT_MS, 'single-channel sample selects Bank A');

    console.log('\n6. Sequencer Stop stops playback immediately…');
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

    console.log('\n8. Deleting the same slot again restores it…');
    await page.evaluate((note) => window.__loopPadTest.noteOn(note), firstNote);
    await page.evaluate((note) => window.__loopPadTest.noteOn(note), deleteNote);
    state = await waitFor(page, () => {
      const st = window.__loopPadTest.getState();
      return st.slots[0].state === 'stopped' && st.slots[0].hasSample ? st : null;
    }, 2000, 'slot 0 restored by a second delete');
    assertEq(state.slots[0].state, 'stopped', 'Second delete restores slot 0');
    assert(state.slots[0].hasSample, 'Restored slot 0 has its stored sample');

    console.log('\n9. A zero recording tail stops capture immediately…');
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

    console.log('\n10. Take mode records sequentially from empty slots and finalizes via MIDI…');
    await page.evaluate(() => window.__loopPadTest.updateSettings({ recordingTailMs: 300 }));
    await page.evaluate((note) => window.__loopPadTest.noteOn(note), takeModeNote);
    await waitFor(page, () => {
      const st = window.__loopPadTest.getState();
      return st.settings.recordingMode === 'take' && st.settings.recordingTailMs === 300 ? st : null;
    }, TIMEOUT_MS, 'Take mode enabled by MIDI with recording tail enabled');
    await page.evaluate((note) => window.__loopPadTest.noteOn(note), firstNote + 2);
    await page.waitForTimeout(400);
    await page.evaluate((note) => window.__loopPadTest.noteOff(note), firstNote + 2);
    await page.waitForTimeout(100);
    await page.evaluate((note) => window.__loopPadTest.noteOn(note), firstNote + 2);
    state = await waitFor(page, () => {
      const st = window.__loopPadTest.getState();
      return st.slots[2].state === 'recording' && st.selectedSlot === 2 ? st : null;
    }, TIMEOUT_MS, 'second take recording after previous tail is interrupted');
    assertEq(state.slots[2].state, 'recording', 'Second take starts on the following sequencer pass');
    assertEq(state.selectedSlot, 2, 'First take completes before the second take records');
    const precedingTakeDurationSecs = state.slots[2].durationSecs;
    const finalizationDelayMs = 100;
    await page.waitForTimeout(finalizationDelayMs);
    await page.evaluate((note) => window.__loopPadTest.noteOn(note), takeModeNote);
    state = await waitFor(page, () => {
      const st = window.__loopPadTest.getState();
      return st.slots[2].state === 'playing' && st.slots[2].playbackProgress !== null ? st : null;
    }, TIMEOUT_MS, 'active take finalized and playing');
    assertEq(state.slots[2].state, 'playing', 'Finalizing a Take-mode slot immediately plays its sample');
    assertEq(state.slots[2].durationSecs, precedingTakeDurationSecs, 'Finalization keeps the preceding completed take');
    assert(
      state.slots[2].playbackProgress >= finalizationDelayMs / (precedingTakeDurationSecs * 1000),
      'Finalized take playback and ring resume at the elapsed timeline position',
    );
    await page.evaluate((note) => window.__loopPadTest.noteOff(note), firstNote + 2);
    await page.evaluate((note) => window.__loopPadTest.noteOn(note), firstNote + 2);
    state = await page.evaluate(() => window.__loopPadTest.getState());
    assertEq(state.slots[2].state, 'playing', 'Loaded finalized slot cannot start another take');
    await page.evaluate((note) => {
      window.__loopPadTest.noteOn(note);
      window.__loopPadTest.noteOn(window.__loopPadTest.getState().settings.deleteNote);
    }, firstNote + 2);
    await waitFor(page, () => window.__loopPadTest.getState().slots[2].state === 'empty', TIMEOUT_MS, 'finalized take deleted');
    await page.evaluate((note) => window.__loopPadTest.noteOn(note), firstNote + 2);
    state = await waitFor(page, () => {
      const st = window.__loopPadTest.getState();
      return st.slots[2].state === 'recording' ? st : null;
    }, TIMEOUT_MS, 'new take recording after deletion');
    assertEq(state.slots[2].state, 'recording', 'Deleted slot starts a new take on the next sequencer pass');
    await page.evaluate((note) => window.__loopPadTest.noteOn(note), takeModeNote);
    state = await waitFor(page, () => {
      const st = window.__loopPadTest.getState();
      return st.slots[2].state === 'playing' ? st : null;
    }, TIMEOUT_MS, 'first replacement take finalized and playing');
    assertEq(state.slots[2].state, 'playing', 'Take Mode note immediately plays a finalized active first take');
    await page.evaluate((note) => window.__loopPadTest.noteOff(note), firstNote + 2);
    await page.evaluate(([sampleNote, resetNote]) => {
      window.__loopPadTest.noteOn(sampleNote);
      window.__loopPadTest.noteOn(resetNote);
    }, [firstNote + 2, deleteNote]);
    await waitFor(page, () => window.__loopPadTest.getState().slots[2].state === 'empty', TIMEOUT_MS, 'replacement take deleted before new recording');
    await page.evaluate((note) => window.__loopPadTest.noteOn(note), firstNote + 2);
    await waitFor(page, () => {
      const st = window.__loopPadTest.getState();
      return st.slots[2].state === 'recording' && st.selectedSlot === 2 ? st : null;
    }, TIMEOUT_MS, 'replacement take recording before selecting another slot');
    await page.evaluate((note) => window.__loopPadTest.noteOn(note), firstNote + 4);
    state = await waitFor(page, () => {
      const st = window.__loopPadTest.getState();
      return st.slots[2].state === 'empty' && st.slots[4].state === 'recording' && st.selectedSlot === 4 ? st : null;
    }, TIMEOUT_MS, 'unfinalized take discarded when selecting another slot');
    assertEq(state.slots[2].state, 'empty', 'Selecting another slot clears the previous unfinalized take');
    await page.evaluate(() => window.__loopPadTest.updateSettings({ recordingTailMs: 0 }));
    await page.evaluate((note) => window.__loopPadTest.noteOn(note), oneShotModeNote);
    await waitFor(page, () => {
      const st = window.__loopPadTest.getState();
      return st.settings.recordingMode === 'one-shot' && st.settings.recordingTailMs === 0 ? st : null;
    }, TIMEOUT_MS, 'One-shot mode enabled by MIDI and zero recording tail restored');

    console.log('\n11. Recording another slot selects it…');
    await page.evaluate((note) => window.__loopPadTest.noteOn(note), firstNote + 3);
    await page.waitForTimeout(400);
    await page.evaluate((note) => window.__loopPadTest.noteOff(note), firstNote + 3);
    state = await waitFor(page, () => {
      const st = window.__loopPadTest.getState();
      return st.slots[3].state === 'stopped' && st.selectedSlot === 3 ? st : null;
    }, TIMEOUT_MS, 'slot 3 finished recording and selected');

    console.log('\n12. Standalone Reset clears the selection while running…');
    await page.evaluate((note) => window.__loopPadTest.noteOn(note), deleteNote);
    state = await waitFor(page, () => {
      const st = window.__loopPadTest.getState();
      return st.slots[3].state === 'empty' && st.selectedSlot === null ? st : null;
    }, TIMEOUT_MS, 'selected slot and selection cleared by standalone Reset');
    assertEq(state.slots[3].state, 'empty', 'Standalone Reset clears selected slot while running');
    assertEq(state.selectedSlot, null, 'Reset clears the selection after deleting its slot');

    console.log('\n13. Project switch resets the visible slots and persists across reload…');
    await page.getByRole('button', { name: 'Project 01' }).click();
    await page.getByRole('dialog', { name: 'Project options' }).getByLabel('Project').selectOption('2');
    state = await waitFor(page, () => {
      const st = window.__loopPadTest.getState();
      return st.projectIndex === 2 ? st : null;
    }, TIMEOUT_MS, 'project switched to 2');
    assertEq(state.projectIndex, 2, 'Project index is 2');
    assert(state.slots.every((s) => s.state === 'empty'), 'Fresh project has all-empty slots');
    await page.reload({ waitUntil: 'domcontentloaded' });
    state = await waitFor(page, () => {
      const st = window.__loopPadTest?.getState();
      return st?.ready && st.projectIndex === 2 ? st : null;
    }, TIMEOUT_MS, 'last selected project restored after reload');
    assertEq(state.projectIndex, 2, 'Reload restores the last selected project');
    await page.getByRole('button', { name: 'Project 02' }).click();
    await page.getByRole('dialog', { name: 'Project options' }).getByLabel('Project').selectOption('1');
    await waitFor(page, () => {
      const st = window.__loopPadTest.getState();
      return st.projectIndex === 1 ? st : null;
    }, TIMEOUT_MS, 'project switched back to 1');

    console.log('\n13. Initialize clears the current project…');
    await page.getByRole('button', { name: 'Project 01' }).click();
    page.once('dialog', (dialog) => void dialog.accept());
    await page.getByRole('dialog', { name: 'Project options' }).getByRole('button', { name: 'Initialize' }).click();
    state = await waitFor(page, () => {
      const st = window.__loopPadTest.getState();
      return st.slots.every((slot) => slot.state === 'empty') && st.selectedSlot === null ? st : null;
    }, TIMEOUT_MS, 'current project initialized');
    assert(state.slots.every((slot) => slot.state === 'empty'), 'Initialize clears every slot in the current project');
    assertEq(state.selectedSlot, null, 'Initialize clears the selection');
    await page.getByRole('button', { name: 'Project 01' }).click();
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('dialog', { name: 'Project options' }).getByRole('button', { name: 'Download' }).click();
    const download = await downloadPromise;
    assert(download.suggestedFilename().endsWith('.zip'), 'Project pane downloads the project archive');
    const archive = await readFile(await download.path());
    await page.getByRole('button', { name: 'Project 01' }).click();
    const chooserPromise = page.waitForEvent('filechooser');
    await page.getByRole('dialog', { name: 'Project options' }).getByRole('button', { name: 'Restore' }).click();
    const chooser = await chooserPromise;
    await chooser.setFiles({ name: 'projects.zip', mimeType: 'application/zip', buffer: archive });
    await page.getByText(/^Restored /).waitFor();
    assert(true, 'Project pane restores a downloaded archive');

    console.log('\n14. Count-in turns on and off from dedicated channel-16 MIDI notes…');
    await page.evaluate(([note, channel]) => window.__loopPadTest.noteOn(note, 100, channel), [countInOnNote, 14]);
    state = await page.evaluate(() => window.__loopPadTest.getState());
    assertEq(state.settings.countInEnabled, false, 'Count-in ignores its On note on another channel');
    await page.evaluate((note) => window.__loopPadTest.noteOn(note), countInOnNote);
    state = await waitFor(page, () => {
      const st = window.__loopPadTest.getState();
      return st.settings.countInEnabled ? st : null;
    }, TIMEOUT_MS, 'count-in enabled by MIDI On note');
    assert(state.settings.countInEnabled, 'Count-in enabled by MIDI On note');
    assertEq(await page.locator('.count-in-status').textContent(), 'Count-in On', 'Count-in status reflects the MIDI On note');
    await page.evaluate((note) => window.__loopPadTest.noteOn(note), countInOffNote);
    state = await waitFor(page, () => {
      const st = window.__loopPadTest.getState();
      return !st.settings.countInEnabled ? st : null;
    }, TIMEOUT_MS, 'count-in disabled by MIDI Off note');
    assertEq(state.settings.countInEnabled, false, 'Count-in disabled by MIDI Off note');
    assertEq(await page.locator('.count-in-status').textContent(), 'Count-in Off', 'Count-in status reflects the MIDI Off note');
    await page.evaluate((note) => window.__loopPadTest.noteOn(note), countInOnNote);

    console.log('\n15. Count-in: Start intercepted, then re-Start after N beats of clock…');
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
    await page.evaluate((note) => window.__loopPadTest.noteOn(note), firstNote + 1);
    state = await page.evaluate(() => window.__loopPadTest.getState());
    assertEq(state.slots[1].state, 'recording', 'Slot notes record after count-in without a Start echo');
    await page.evaluate(() => window.__loopPadTest.start());
    state = await page.evaluate(() => window.__loopPadTest.getState());
    assert(!state.countInCounting, 'Echoed Start does not begin another count-in');
    await page.evaluate((note) => window.__loopPadTest.noteOff(note), firstNote + 1);
    await waitFor(page, () => {
      const st = window.__loopPadTest.getState();
      return st.slots[1].state === 'stopped' ? st : null;
    }, TIMEOUT_MS, 'slot 1 recording finished after count-in');

    console.log('\n16. BPM: stabilize after two beats of timestamped MIDI Clock…');
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
    await page.evaluate((note) => window.__loopPadTest.noteOn(note), firstNote + 2);
    await page.waitForTimeout(2200);
    await page.evaluate((note) => window.__loopPadTest.noteOff(note), firstNote + 2);
    state = await waitFor(page, () => {
      const st = window.__loopPadTest.getState();
      return st.selectedSlot === 2 && st.slots[2].state === 'stopped' ? st : null;
    }, TIMEOUT_MS, 'long sample for waveform beat grid');
    await page.evaluate((note) => window.__loopPadTest.noteOn(note), firstNote + 2);
    await waitFor(page, () => {
      const st = window.__loopPadTest.getState();
      return st.slots[2].playbackProgress > 0.05 ? st : null;
    }, TIMEOUT_MS, 'waveform playhead advances');
    const waveformGuides = await page.evaluate((duration) => {
      const canvas = document.querySelector('.sample-waveform');
      const ctx = canvas.getContext('2d');
      const { width, height } = canvas;
      const image = ctx.getImageData(0, 0, width, height).data;
      const pixel = (x, y) => Array.from(image.slice((y * width + x) * 4, (y * width + x) * 4 + 3)).join(',');
      const xAt = (seconds) => Math.round((width - 1) * seconds / duration);
      const spans = (x, color) => pixel(x, 0) === color && pixel(x, height - 1) === color;
      const playheadX = Array.from({ length: width }, (_, x) => x).find((x) => spans(x, '255,255,255'));
      return {
        weakBeat: spans(xAt(0.5), '82,90,92'),
        strongBeat: spans(xAt(2), '120,129,131'),
        start: spans(0, '244,233,0'),
        end: spans(width - 1, '244,233,0'),
        playhead: playheadX !== undefined,
        noMarkerHeads: pixel(4, 5) === '0,0,0' && pixel(width - 5, 5) === '0,0,0'
          && playheadX !== undefined && pixel(playheadX + 4, 5) !== '255,255,255',
      };
    }, state.slots[2].durationSecs);
    assert(waveformGuides.weakBeat && waveformGuides.strongBeat, 'Solid beat lines span the waveform and every fourth is lighter');
    assert(waveformGuides.start && waveformGuides.end && waveformGuides.playhead, 'Start, tail end, and playhead span the full waveform height');
    assert(waveformGuides.noMarkerHeads, 'Waveform markers have no circular heads');
    await page.evaluate((note) => window.__loopPadTest.noteOff(note), firstNote + 2);
    assertEq(await page.getByRole('button', { name: 'Count-in', exact: true }).count(), 0, 'Count-in remains a status after tempo is measured');
    await page.evaluate(() => window.__loopPadTest.start());
    state = await waitFor(page, () => {
      const st = window.__loopPadTest.getState();
      return st.countInCounting ? st : null;
    }, TIMEOUT_MS, 'MIDI count-in started with measured tempo');
    assert(state.countInCounting, 'MIDI Start initiates count-in with measured tempo');
    state = await waitFor(page, () => {
      const st = window.__loopPadTest.getState();
      return !st.countInCounting ? st : null;
    }, TIMEOUT_MS, 'MIDI count-in finished without incoming Clock');
    assert(!state.countInCounting, 'MIDI count-in restarts transport using the measured tempo');
    await page.evaluate(() => window.__loopPadTest.stop());
    state = await waitFor(page, () => {
      const st = window.__loopPadTest.getState();
      return st.bpm === null ? st : null;
    }, TIMEOUT_MS, 'BPM cleared on Stop');
    assertEq(state.bpm, null, 'BPM clears on Stop');
    await page.waitForFunction((duration) => {
      const canvas = document.querySelector('.sample-waveform');
      const ctx = canvas.getContext('2d');
      return [0.5, 2].every((seconds) => {
        const x = Math.round((canvas.width - 1) * seconds / duration);
        const pixel = ctx.getImageData(x, 0, 1, 1).data;
        return pixel[0] === 0 && pixel[1] === 0 && pixel[2] === 0;
      });
    }, state.slots[2].durationSecs);
    assert(true, 'Beat guides disappear when MIDI Clock tempo is unknown');

    console.log('\n17. Invalid project recovery clears only project memory…');
    await page.waitForTimeout(1000); // let the preceding recording autosave settle
    const corruptProjectIndex = await page.evaluate(() => window.__loopPadTest.getState().projectIndex);
    await page.evaluate(async (index) => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('loop-pad-projects');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise((resolve, reject) => {
        const transaction = db.transaction('projects', 'readwrite');
        transaction.objectStore('projects').put({
          name: `project-${String(index).padStart(2, '0')}`, savedAt: Date.now(), bytes: new Uint8Array([0, 0, 0, 0]),
        });
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
      db.close();
    }, corruptProjectIndex);
    await page.reload({ waitUntil: 'domcontentloaded' });
    const reloadInitBtn = page.locator('button', { hasText: 'Enable Audio' });
    if (await reloadInitBtn.isVisible({ timeout: 3000 }).catch(() => false)) await reloadInitBtn.click();
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
