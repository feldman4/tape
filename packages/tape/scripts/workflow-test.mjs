#!/usr/bin/env node
// Workflow test: validates the full single-track edit + session save/load cycle.
// Does NOT require the OP-Z or any real audio hardware — uses __tapeTest.injectClip()
// to synthesize clips, so it can run in any environment where the dev server is up.
//
// Prerequisites:
//   1. npm run dev          (dev server must be running)
//   2. npm run test:hardware:setup   (one-time mic+MIDI permission grant into
//                                    .playwright-profile/; can skip if already done)
//
// Run:
//   npm run test:workflow
//
// The script uses the same persistent Chrome profile as the hardware tests so it
// inherits existing mic permission (needed for AudioContext init).

import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = path.join(__dirname, '..', '.playwright-profile');
const APP_URL = 'http://localhost:5173';
const TIMEOUT_MS = 20_000;

// ---------------------------------------------------------------------------
// Helper: poll until condition or timeout
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------
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

function assertApprox(actual, expected, tol, label) {
  assert(Math.abs(actual - expected) <= tol, label, `got ${actual.toFixed(4)}, expected ${expected.toFixed(4)} ±${tol}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
(async () => {
  const browser = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    args: ['--use-fake-ui-for-media-stream'], // auto-grants mic without a prompt
  });

  const page = browser.pages()[0] ?? await browser.newPage();
  console.log('\n=== Tape Workflow Test ===\n');

  try {
    // -------------------------------------------------------------------------
    // Step 1: Navigate and enable audio
    // -------------------------------------------------------------------------
    console.log('1. Navigate to app and enable audio…');
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });

    // Click "Enable Audio + MIDI" if visible
    const initBtn = page.locator('button', { hasText: 'Enable Audio' });
    if (await initBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await initBtn.click();
    }

    // Wait for ready state (MIDI may fail in headless — that's OK for this test)
    await waitFor(
      page,
      () => window.__tapeTest?.getState()?.ready === true,
      TIMEOUT_MS,
      'app ready',
    );
    const initState = await page.evaluate(() => window.__tapeTest.getState());
    assert(initState.ready, 'App initialised');
    console.log(`   Audio ready (MIDI: ${initState.midiInputs.length} inputs, ${initState.midiOutputs.length} outputs)`);

    // -------------------------------------------------------------------------
    // Step 2: Inject two synthetic clips
    // -------------------------------------------------------------------------
    console.log('\n2. Inject two synthetic clips…');
    const clip0Id = await page.evaluate(() => window.__tapeTest.injectClip(2, 0));   // 2s at t=0
    await page.evaluate(() => window.__tapeTest.injectClip(1.5, 3)); // 1.5s at t=3s
    await page.waitForTimeout(300); // let React state settle

    let state = await page.evaluate(() => window.__tapeTest.getState());
    assertEq(state.tape.clips.length, 2, '2 clips on lane after inject');
    assertApprox(state.tape.clips[0].tapeStartSecs, 0, 0.01, 'Clip 0 tapeStart ≈ 0s');
    assertApprox(state.tape.clips[0].durationSecs, 2, 0.02, 'Clip 0 duration ≈ 2s');
    assertApprox(state.tape.clips[1].tapeStartSecs, 3, 0.01, 'Clip 1 tapeStart ≈ 3s');
    assertApprox(state.tape.clips[1].durationSecs, 1.5, 0.02, 'Clip 1 duration ≈ 1.5s');

    // -------------------------------------------------------------------------
    // Step 3: Split clip 0 at 1s
    // -------------------------------------------------------------------------
    console.log('\n3. Split clip 0 at 1s…');
    await page.evaluate((id) => window.__tapeTest.splitClip(id, 1), clip0Id);
    await page.waitForTimeout(300);

    state = await page.evaluate(() => window.__tapeTest.getState());
    assertEq(state.tape.clips.length, 3, '3 clips after split');
    // Find the two halves (sorted by tapeStart)
    const sorted = [...state.tape.clips].sort((a, b) => a.tapeStart - b.tapeStart);
    assertApprox(sorted[0].durationSecs, 1, 0.02, 'Left half of split ≈ 1s');
    assertApprox(sorted[1].tapeStartSecs, 1, 0.02, 'Right half tapeStart ≈ 1s');
    assertApprox(sorted[1].durationSecs, 1, 0.02, 'Right half duration ≈ 1s');
    assertApprox(sorted[2].tapeStartSecs, 3, 0.01, 'Clip 1 still at 3s after split');

    // -------------------------------------------------------------------------
    // Step 4: Save session
    // -------------------------------------------------------------------------
    console.log('\n4. Save session "workflow-test"…');
    await page.evaluate(() => window.__tapeTest.saveSession('workflow-test'));
    await page.waitForTimeout(500);

    const sessionsBefore = await page.evaluate(() => window.__tapeTest.listSessions());
    assert(sessionsBefore.includes('workflow-test'), 'Session "workflow-test" listed after save');

    // Snapshot the clip layout for later comparison
    const clipsBefore = state.tape.clips.map((c) => ({
      tapeStart: c.tapeStart,
      duration: c.duration,
    })).sort((a, b) => a.tapeStart - b.tapeStart);
    const loopBefore = {
      loopIn: state.tape.loopIn,
      loopOut: state.tape.loopOut,
      loopEnabled: state.tape.loopEnabled,
    };

    // -------------------------------------------------------------------------
    // Step 5: Page reload + re-init
    // -------------------------------------------------------------------------
    console.log('\n5. Reload page…');
    await page.reload({ waitUntil: 'domcontentloaded' });

    const initBtn2 = page.locator('button', { hasText: 'Enable Audio' });
    if (await initBtn2.isVisible({ timeout: 3000 }).catch(() => false)) {
      await initBtn2.click();
    }

    await waitFor(
      page,
      () => window.__tapeTest?.getState()?.ready === true,
      TIMEOUT_MS,
      'app ready after reload',
    );

    const stateAfterReload = await page.evaluate(() => window.__tapeTest.getState());
    assert(stateAfterReload.ready, 'App re-initialised after reload');
    assertEq(stateAfterReload.tape.clips.length, 0, 'No clips on fresh reload (expected)');

    // -------------------------------------------------------------------------
    // Step 6: Load session and verify
    // -------------------------------------------------------------------------
    console.log('\n6. Load session "workflow-test" and verify…');
    await page.evaluate(() => window.__tapeTest.loadSession('workflow-test'));
    await page.waitForTimeout(500);

    state = await page.evaluate(() => window.__tapeTest.getState());
    assertEq(state.tape.clips.length, 3, '3 clips restored after load');

    const clipsAfter = state.tape.clips.map((c) => ({
      tapeStart: c.tapeStart,
      duration: c.duration,
    })).sort((a, b) => a.tapeStart - b.tapeStart);

    for (let i = 0; i < 3; i++) {
      const before = clipsBefore[i];
      const after = clipsAfter[i];
      if (!before || !after) { failed++; console.error(`  ✗ clip ${i} missing`); continue; }
      assert(
        Math.abs(before.tapeStart - after.tapeStart) <= 1,
        `Clip ${i} tapeStart matches (${before.tapeStart} samples)`,
      );
      assert(
        Math.abs(before.duration - after.duration) <= 1,
        `Clip ${i} duration matches (${before.duration} samples)`,
      );
    }

    assertApprox(state.tape.tapeLength / 44100, 4.5, 0.1, 'Tape length ≈ 4.5s after load');

    // -------------------------------------------------------------------------
    // Step 7: Verify loop state round-trips
    // -------------------------------------------------------------------------
    console.log('\n7. Verify loop state persists through save/load…');
    assertEq(state.tape.loopEnabled, loopBefore.loopEnabled, 'Loop enabled state matches saved session');
    assertEq(state.tape.loopIn, loopBefore.loopIn, 'Loop in point matches saved session');
    assertEq(state.tape.loopOut, loopBefore.loopOut, 'Loop out point matches saved session');

  } catch (err) {
    console.error('\nTest runner error:', err.message);
    failed++;
  } finally {
    await browser.close();
  }

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  console.log(`\n${'='.repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(40));
  process.exit(failed > 0 ? 1 : 0);
})();
