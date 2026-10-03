#!/usr/bin/env node
// Renders the real Loop Pad UI into docs/front-panel.png. Start the Vite dev
// server first, then run `npm run render:front-panel --workspace=loop-pad`.

import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';

const appUrl = process.env.LOOP_PAD_URL ?? 'http://localhost:5173/tape/loop-pad/';
const outputPath = fileURLToPath(new URL('../docs/front-panel.png', import.meta.url));

const browser = await chromium.launch({
  headless: false,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});

try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1080 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  await page.goto(appUrl, { waitUntil: 'domcontentloaded' });

  const enableButton = page.getByRole('button', { name: 'Enable Audio + MIDI' });
  if (await enableButton.isVisible({ timeout: 3000 }).catch(() => false)) {
    await enableButton.click();
  }
  await page.waitForFunction(() => window.__loopPadTest?.getState().ready === true, { timeout: 20_000 });

  const firstNote = await page.evaluate(() => window.__loopPadTest.getState().settings.firstSampleNote);
  await page.evaluate(() => window.__loopPadTest.start());
  await page.evaluate((note) => window.__loopPadTest.noteOn(note), firstNote);
  await page.waitForTimeout(350);
  await page.evaluate((note) => window.__loopPadTest.noteOff(note), firstNote);
  await page.waitForFunction(
    () => {
      const state = window.__loopPadTest.getState();
      return state.slots[0]?.state === 'stopped' && state.selectedSlot === 0;
    },
    { timeout: 20_000 },
  );
  await page.evaluate((note) => window.__loopPadTest.noteOn(note), firstNote + 1);
  await page.waitForFunction(() => window.__loopPadTest.getState().slots[1]?.state === 'recording', { timeout: 20_000 });
  await page.waitForTimeout(250);

  await page.screenshot({ path: outputPath });
  console.log(`Rendered ${outputPath}`);
} finally {
  await browser.close();
}