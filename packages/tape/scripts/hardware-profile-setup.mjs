#!/usr/bin/env node
// One-time setup: launches a persistent Chrome profile, opens the app, and
// waits for you to manually grant the microphone + MIDI permission prompts.
// Chrome saves permission grants per-origin inside the user-data-dir, so
// every later run of scripts/hardware-test.mjs (using the same profile
// directory) reuses this grant and never shows the prompts again - no human
// needed after this one-time step.
//
// Usage:
//   npm run dev              (in one terminal - dev server must be running)
//   npm run test:hardware:setup   (in another terminal)
//
// Then in the Chrome window that opens: click "Enable Audio + MIDI" and
// accept both the microphone and MIDI permission prompts. Once the page
// shows device dropdowns, press Ctrl+C here to finish.

import { chromium } from 'playwright';
import { PROFILE_DIR, BASE_URL } from './hardware-test-config.mjs';

const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: false,
  viewport: null,
  args: ['--start-maximized'],
});

const page = context.pages()[0] ?? (await context.newPage());
await page.goto(BASE_URL);

console.log(`Profile dir: ${PROFILE_DIR}`);
console.log('Click "Enable Audio + MIDI" in the browser window and accept both permission prompts.');
console.log('Once the audio/MIDI device dropdowns appear, permissions are saved. Press Ctrl+C to exit.');

process.on('SIGINT', async () => {
  await context.close();
  process.exit(0);
});

// Keep the process (and browser) alive until the user is done and hits Ctrl+C.
await new Promise(() => {});
