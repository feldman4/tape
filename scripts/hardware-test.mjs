#!/usr/bin/env node
// Automated Stage 0 hardware validation (docs/stage0-progress.md item 11 /
// docs/testing_proposal.md "Interface" + "End-to-end" levels), driven
// entirely by the OP-Z: no human interaction required once
// scripts/hardware-profile-setup.mjs has been run once to grant mic + MIDI
// permission into the persistent Chrome profile.
//
// Preconditions (see docs/testing_proposal.md "Reference Source: OP-Z"):
//   - OP-Z is powered on and connected via USB (class-compliant audio + MIDI).
//   - `npm run dev` is running and reachable at TAPE_TEST_URL (default
//     http://localhost:5173).
//   - scripts/hardware-profile-setup.mjs has been run at least once for this
//     machine/profile dir.
//   - The OP-Z's channel-1 percussion track has an audible voice assigned,
//     and its project tempo is set to whatever it should be for this run
//     (tempo/pattern are not remote-controlled by this script).
//   - For the metronome calibration step (1.5): the OP-Z's sequencer should
//     have no active notes so only the built-in metronome click sounds into
//     the mic.  (Other steps are unaffected by this.)
//
// What it exercises:
//   1.   OP-Z note-to-sound latency (send Note On -> record -> onset-detect).
//   1.5. Metronome latency calibration (record metronome clicks while MIDI
//        Clock runs; measure per-beat offsets; derive calibrated L_in).
//   2.   Free-mode recording (record while triggering a percussion note).
//   3.   Sync-mode recording (send MIDI Start, let the OP-Z drive Sync mode
//        via its own MIDI Clock, verify a beat-accurate clip is produced).
//
// This does not replace docs/testing_proposal.md's DSP/property tests (those
// need no hardware); it covers the two tiers that do.

import { chromium } from 'playwright';
import * as readline from 'node:readline/promises';
import { PROFILE_DIR, BASE_URL } from './hardware-test-config.mjs';

async function confirmSetup() {
  console.log(`
┌─────────────────────────────────────────────────────────────┐
│              Tape — OP-Z hardware test checklist             │
├─────────────────────────────────────────────────────────────┤
│  Physical setup                                             │
│    [ ] OP-Z powered on and connected via USB                │
│    [ ] USB cable carries both audio and MIDI                │
│        (some cables are charge-only — use a data cable)     │
│                                                             │
│  OP-Z configuration                                         │
│    [ ] Channel-1 percussion track has an audible voice      │
│    [ ] Metronome is enabled (needed for step 1.5)           │
│    [ ] For step 1.5: sequencer has NO active notes          │
│        (only the metronome click should sound into the mic) │
│    [ ] Project tempo is set to the desired BPM              │
│                                                             │
│  Host software                                              │
│    [ ] \`npm run dev\` is running at ${BASE_URL.padEnd(27)}│
│    [ ] \`npm run test:hardware:setup\` was run at least once │
│        on this machine (grants mic + MIDI permissions)      │
└─────────────────────────────────────────────────────────────┘
`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question('All boxes checked? Press Enter to continue, or type "n" to abort: ');
    if (answer.trim().toLowerCase() === 'n') {
      console.log('Aborted.');
      process.exit(0);
    }
  } finally {
    rl.close();
  }
}

const results = [];

function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function getState(page) {
  return page.evaluate(() => {
    const api = window.__tapeTest;
    if (!api) throw new Error('window.__tapeTest not found — is this the Tape app?');
    return api.getState();
  });
}

/** Switch to a named tab (TAPE | MIXER | PROJ | COM | TEST). */
async function tab(page, name) {
  await page.getByRole('button', { name, exact: true }).first().click();
}

async function main() {
  await confirmSetup();

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: process.env.TAPE_TEST_HEADLESS === '1',
    viewport: null,
  });
  const page = context.pages()[0] ?? (await context.newPage());

  try {
    await page.goto(BASE_URL);

    // Wait for the app to initialise automatically (no button click needed).
    await page
      .waitForFunction(() => window.__tapeTest?.getState()?.ready === true, { timeout: 10_000 })
      .catch(() => {
        throw new Error(
          'App did not become ready within 10s. If this is the first run, use ' +
            '`npm run test:hardware:setup` first to grant mic/MIDI permissions into the persistent profile.',
        );
      });

    let state = await getState(page);
    if (state.error) throw new Error(`App reported an error: ${state.error}`);

    // --- Verify the OP-Z is actually the selected device (per task precondition) ---
    const isOpZ = (label) => (label ?? '').toLowerCase().includes('op-z');
    const audioIsOpZ = state.audioDevices.some((d) => d.id === state.selectedAudioDeviceId && isOpZ(d.label));
    const midiInIsOpZ = state.midiInputs.some((i) => i.id === state.selectedMidiInputId && isOpZ(i.name));
    const midiOutIsOpZ = state.midiOutputs.some((o) => o.id === state.selectedMidiOutputId && isOpZ(o.name));
    record('OP-Z audio input selected', audioIsOpZ, JSON.stringify(state.audioDevices));
    record('OP-Z MIDI input selected', midiInIsOpZ, JSON.stringify(state.midiInputs));
    record('OP-Z MIDI output selected', midiOutIsOpZ, JSON.stringify(state.midiOutputs));
    if (!audioIsOpZ || !midiOutIsOpZ) {
      throw new Error('OP-Z not detected as both an audio input and a MIDI output. Check the USB connection and that it is powered on.');
    }

    // --- 1. OP-Z note-to-sound latency ---
    await tab(page, 'TEST');
    await page.getByRole('button', { name: 'Run OP-Z Latency Test' }).click();
    await page.waitForFunction(() => window.__tapeTest?.getState()?.noteLatency !== null, { timeout: 5_000 });
    state = await getState(page);
    const latencyOk = typeof state.noteLatency.latencyMs === 'number' && state.noteLatency.latencyMs >= 0 && state.noteLatency.latencyMs < 1000;
    record('OP-Z note-to-sound latency measured', latencyOk, `${state.noteLatency.latencyMs?.toFixed(1)} ms`);

    // --- 1.5. Metronome latency calibration ---
    // For accurate results the OP-Z sequencer should have no active notes here;
    // only the built-in metronome click should be audible.
    // Robust to hardware not being present: timeout is caught, assertions are skipped.
    const calibHandle = page.evaluate(() => window.__tapeTest.calibrateMetronomeLatency(8));
    await page.getByRole('button', { name: 'Send MIDI Start' }).click();
    let cal = null;
    try {
      cal = await calibHandle;
    } catch (e) {
      record('Metronome calibration completed', false, String(e.message));
    }
    await page.getByRole('button', { name: 'Send MIDI Stop' }).click();
    await page
      .waitForFunction(() => window.__tapeTest?.getState()?.transport === 'idle', { timeout: 5_000 })
      .catch(() => {});
    if (cal) {
      const noteLatMs = state.noteLatency?.latencyMs ?? null;
      // predictedOffset = noteLatency − midiLatencyMs (default 2 ms)
      const predictedOffset = noteLatMs !== null ? noteLatMs - 2 : null;
      record('Calibration: ≥6/8 beats detected', cal.detectedBeats >= 6, `${cal.detectedBeats}/8 beats`);
      record('Calibration: beat jitter < 3 ms', cal.stddevMs < 3, `stddev=${cal.stddevMs.toFixed(2)} ms`);
      record('Calibration: mean offset 0–150 ms', cal.meanOffsetMs >= 0 && cal.meanOffsetMs < 150, `mean=${cal.meanOffsetMs.toFixed(1)} ms`);
      if (predictedOffset !== null) {
        record(
          'Calibration: offset consistent with note latency',
          Math.abs(cal.meanOffsetMs - predictedOffset) < 10,
          `rawOffset=${cal.meanOffsetMs.toFixed(1)} ms, predicted=${predictedOffset.toFixed(1)} ms`,
        );
      }
      record('Calibration: L_in ≥ 0 ms', cal.calibratedLinMs >= 0, `L_in=${cal.calibratedLinMs.toFixed(1)} ms`);
    }

    // --- 2. Free-mode recording ---
    await tab(page, 'TAPE');
    await page.getByRole('radio', { name: 'Free' }).check();
    await page.getByRole('button', { name: /record/i }).click();
    await page.waitForTimeout(300);
    await tab(page, 'TEST');
    await page.getByRole('button', { name: /send test note/i }).click();
    await page.waitForTimeout(1000);
    await tab(page, 'TAPE');
    await page.getByRole('button', { name: /stop/i }).click();
    await page.waitForFunction(() => window.__tapeTest?.getState()?.transport === 'idle', { timeout: 5_000 });
    state = await getState(page);
    const freeHasClip = state.tape?.lanes?.some((l) => l.clips?.length > 0);
    record('Free-mode recording produced a clip', freeHasClip, JSON.stringify(state.tape?.lanes?.map((l) => l.clips?.length)));

    // --- 3. Sync-mode recording, driven entirely by the OP-Z's own transport ---
    await tab(page, 'TAPE');
    await page.getByRole('radio', { name: 'Sync' }).check();
    await page.getByRole('button', { name: /arm/i }).click();
    await tab(page, 'TEST');
    await page.getByRole('button', { name: 'Send MIDI Start' }).click();
    // Diagnostic: does the OP-Z echo MIDI Start (0xFA) back? syncRunning is only
    // true when STATUS_START is received from the OP-Z MIDI output.
    const midiStartEchoed = await page
      .waitForFunction(() => window.__tapeTest?.getState()?.sync?.running === true, { timeout: 3_000 })
      .then(() => true)
      .catch(() => false);
    record('OP-Z echoes MIDI Start back', midiStartEchoed,
      midiStartEchoed ? 'sync.running became true' : 'sync.running stayed false — OP-Z only sends Clock, not Start');
    await page
      .waitForFunction(() => window.__tapeTest?.getState()?.transport === 'recording', { timeout: 5_000 })
      .catch(() => {
        throw new Error('OP-Z Start did not arrive back over MIDI in time — check the MIDI input selection/cabling.');
      });
    await page.waitForTimeout(4000); // let a few beats elapse
    await tab(page, 'TAPE');
    await page.getByRole('button', { name: /stop/i }).click();
    await tab(page, 'TEST');
    await page.getByRole('button', { name: 'Send MIDI Stop' }).click(); // stop the OP-Z's transport too
    await page.waitForFunction(() => window.__tapeTest?.getState()?.transport === 'idle', { timeout: 5_000 });
    state = await getState(page);
    const syncHasClip = state.tape?.lanes?.some((l) => l.clips?.length > 0) && typeof state.lastClipBeats === 'number' && state.lastClipBeats > 0;
    record('Sync-mode recording produced a beat-accurate clip', syncHasClip, JSON.stringify({ clipCounts: state.tape?.lanes?.map((l) => l.clips?.length), lastClipBeats: state.lastClipBeats }));
  } finally {
    await context.close();
  }
}

main()
  .then(() => {
    const failed = results.filter((r) => !r.pass);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
    process.exit(failed.length > 0 ? 1 : 0);
  })
  .catch((err) => {
    console.error(`\nHardware test aborted: ${err.message}`);
    process.exit(1);
  });
