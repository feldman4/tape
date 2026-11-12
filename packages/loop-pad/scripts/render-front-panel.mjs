#!/usr/bin/env node
// Renders the real Loop Pad UI into docs/front-panel.png. Start the Vite dev
// server first, then run `npm run render:front-panel --workspace=loop-pad`.

import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const appUrl = process.env.LOOP_PAD_URL ?? 'http://localhost:5173/tape/loop-pad/';
const outputPath = fileURLToPath(new URL('../docs/front-panel.png', import.meta.url));

// Feed the real recording path a repeatable, decaying signal instead of
// Chromium's sparse default fake microphone pulses.
const dir = await mkdtemp(join(tmpdir(), 'loop-pad-render-'));
const audioPath = join(dir, 'input.wav');
const sampleRate = 48000;
const frames = sampleRate * 20;
const wav = Buffer.alloc(44 + frames * 2);
wav.write('RIFF', 0);
wav.writeUInt32LE(wav.length - 8, 4);
wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(sampleRate, 24);
wav.writeUInt32LE(sampleRate * 2, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write('data', 36);
wav.writeUInt32LE(frames * 2, 40);
let noise = 1234567;
for (let i = 0; i < frames; i++) {
  noise = (Math.imul(noise, 1664525) + 1013904223) >>> 0;
  const t = i / sampleRate;
  const signal = ((noise / 0xffffffff - 0.5) * 0.7 + Math.sin(t * 2 * Math.PI * 120) * 0.3) * Math.exp(-t * 0.9);
  wav.writeInt16LE(Math.round(signal * 24000), 44 + i * 2);
}
await writeFile(audioPath, wav);

let browser;
try {
  browser = await chromium.launch({
    headless: false,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${audioPath}`],
  });
  const context = await browser.newContext({
    viewport: { width: 700, height: 940 },
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
  for (const index of [1, 5, 10, 14]) {
    await page.evaluate((note) => window.__loopPadTest.noteOn(note), firstNote + index);
    await page.waitForTimeout(index === 1 ? 2400 : 350);
    await page.evaluate((note) => window.__loopPadTest.noteOff(note), firstNote + index);
    await page.waitForFunction(
      (slotIndex) => {
        const state = window.__loopPadTest.getState();
        return state.slots[slotIndex]?.state === 'stopped' && state.selectedSlot === slotIndex;
      },
      index,
      { timeout: 20_000 },
    );
  }
  await page.evaluate(() => window.__loopPadTest.stop());
  await page.evaluate(() => {
    const firstClock = performance.now();
    for (let i = 0; i < 48; i++) window.__loopPadTest.clock(firstClock + i * 60_000 / (120 * 24));
  });
  await page.waitForFunction(() => window.__loopPadTest.getState().bpm === 120, { timeout: 20_000 });
  await page.evaluate((note) => window.__loopPadTest.noteOn(note), firstNote + 1);
  await page.waitForFunction(() => {
    const state = window.__loopPadTest.getState();
    return state.selectedSlot === 1 && state.slots[1]?.playbackProgress !== null;
  }, { timeout: 20_000 });

  await page.screenshot({ path: outputPath });
  console.log(`Rendered ${outputPath}`);
} finally {
  await browser?.close();
  await unlink(audioPath);
  await rmdir(dir);
}