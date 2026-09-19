#!/usr/bin/env node
// BlackHole stereo loopback diagnostic.
//
// Sends 1 kHz on the left and 2 kHz on the right to a BlackHole output,
// records the matching BlackHole input, then measures each tone in each
// captured channel. Run against a local dev server so getUserMedia has a
// secure localhost origin:
//
//   npm run dev:loop-pad
//   npm run test:blackhole-stereo --workspace=loop-pad
//
// On the first run, grant microphone permission in the launched Chrome
// window. The persistent profile keeps that grant for later runs.
//
// Select a particular BlackHole device when more than one is installed:
//   BLACKHOLE_INPUT='BlackHole 2ch' BLACKHOLE_OUTPUT='BlackHole 2ch' \
//     npm run test:blackhole-stereo --workspace=loop-pad

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const APP_URL = process.env.LOOP_PAD_URL ?? 'http://localhost:5173/tape/loop-pad/';
const PROFILE_DIR = resolve('.playwright-blackhole-profile');
const INPUT_MATCH = process.env.BLACKHOLE_INPUT ?? 'blackhole';
const OUTPUT_MATCH = process.env.BLACKHOLE_OUTPUT ?? 'blackhole';
const LEFT_HZ = 1000;
const RIGHT_HZ = 2000;
const TEST_DURATION_MS = 2200;
const MIN_SEPARATION_DB = 20;

function printMatrix(result) {
  const rows = [
    ['Captured channel', `${LEFT_HZ} Hz`, `${RIGHT_HZ} Hz`, 'Expected tone'],
    ['Left', `${result.left.leftDb.toFixed(1)} dB`, `${result.left.rightDb.toFixed(1)} dB`, `${LEFT_HZ} Hz`],
    ['Right', `${result.right.leftDb.toFixed(1)} dB`, `${result.right.rightDb.toFixed(1)} dB`, `${RIGHT_HZ} Hz`],
  ];
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
  for (const row of rows) console.log(row.map((cell, column) => cell.padEnd(widths[column])).join('  '));
}

await mkdir(PROFILE_DIR, { recursive: true });
const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: process.env.BLACKHOLE_HEADLESS === '1',
  viewport: null,
});
const page = context.pages()[0] ?? (await context.newPage());

try {
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  console.log(`Requesting microphone access at ${APP_URL}`);
  console.log('If Chrome asks, allow microphone access for this local site.');

  const result = await page.evaluate(async ({
    inputMatch, outputMatch, leftHz, rightHz, durationMs,
  }) => {
    const findDevice = (devices, kind, match) => {
      const normalized = match.toLowerCase();
      const device = devices.find((candidate) => candidate.kind === kind && candidate.label.toLowerCase().includes(normalized));
      if (!device) {
        const available = devices
          .filter((candidate) => candidate.kind === kind)
          .map((candidate) => candidate.label || `(unlabelled ${candidate.deviceId})`)
          .join(', ');
        throw new Error(`No ${kind} device matching ${JSON.stringify(match)}. Available: ${available}`);
      }
      return device;
    };

    // This initial request exposes device labels and prompts for permission.
    const permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    permissionStream.getTracks().forEach((track) => track.stop());
    const devices = await navigator.mediaDevices.enumerateDevices();
    const input = findDevice(devices, 'audioinput', inputMatch);
    const output = findDevice(devices, 'audiooutput', outputMatch);

    const outputContext = new AudioContext({ latencyHint: 'interactive' });
    await outputContext.setSinkId(output.deviceId);
    const inputStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: { exact: input.deviceId },
        channelCount: { exact: 2 },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    const inputContext = new AudioContext({ latencyHint: 'interactive' });
    const source = inputContext.createMediaStreamSource(inputStream);
    const processor = inputContext.createScriptProcessor(2048, 2, 2);
    const silent = inputContext.createGain();
    silent.gain.value = 0;
    source.connect(processor);
    processor.connect(silent);
    silent.connect(inputContext.destination);

    const left = outputContext.createOscillator();
    left.frequency.value = leftHz;
    const right = outputContext.createOscillator();
    right.frequency.value = rightHz;
    const leftGain = outputContext.createGain();
    const rightGain = outputContext.createGain();
    leftGain.gain.value = 0.12;
    rightGain.gain.value = 0.12;
    const merger = outputContext.createChannelMerger(2);
    left.connect(leftGain).connect(merger, 0, 0);
    right.connect(rightGain).connect(merger, 0, 1);
    merger.connect(outputContext.destination);

    const capturedLeft = [];
    const capturedRight = [];
    processor.onaudioprocess = (event) => {
      capturedLeft.push(new Float32Array(event.inputBuffer.getChannelData(0)));
      capturedRight.push(new Float32Array(event.inputBuffer.getChannelData(1)));
    };

    await Promise.all([outputContext.resume(), inputContext.resume()]);
    left.start();
    right.start();
    await new Promise((resolve) => setTimeout(resolve, durationMs));
    left.stop();
    right.stop();
    await new Promise((resolve) => setTimeout(resolve, 100));

    processor.disconnect();
    silent.disconnect();
    source.disconnect();
    inputStream.getTracks().forEach((track) => track.stop());
    await Promise.all([outputContext.close(), inputContext.close()]);

    const flatten = (blocks) => {
      const length = blocks.reduce((total, block) => total + block.length, 0);
      const samples = new Float32Array(length);
      let offset = 0;
      for (const block of blocks) {
        samples.set(block, offset);
        offset += block.length;
      }
      return samples;
    };
    const toneLevel = (samples, frequency, sampleRate) => {
      // Ignore startup and shutdown transients, then correlate against a sine/cosine pair.
      const start = Math.floor(samples.length * 0.2);
      const end = Math.floor(samples.length * 0.8);
      let sinSum = 0;
      let cosSum = 0;
      for (let index = start; index < end; index++) {
        const phase = (2 * Math.PI * frequency * index) / sampleRate;
        sinSum += samples[index] * Math.sin(phase);
        cosSum += samples[index] * Math.cos(phase);
      }
      return Math.sqrt(sinSum * sinSum + cosSum * cosSum) / Math.max(1, end - start);
    };
    const toDb = (value) => 20 * Math.log10(Math.max(value, 1e-12));
    const leftSamples = flatten(capturedLeft);
    const rightSamples = flatten(capturedRight);
    if (leftSamples.length === 0 || rightSamples.length === 0) throw new Error('No audio arrived from the selected BlackHole input.');
    const sampleRate = inputContext.sampleRate;
    const matrix = (samples) => ({
      leftDb: toDb(toneLevel(samples, leftHz, sampleRate)),
      rightDb: toDb(toneLevel(samples, rightHz, sampleRate)),
    });
    return {
      input: input.label,
      output: output.label,
      sampleRate,
      capturedFrames: leftSamples.length,
      left: matrix(leftSamples),
      right: matrix(rightSamples),
    };
  }, {
    inputMatch: INPUT_MATCH,
    outputMatch: OUTPUT_MATCH,
    leftHz: LEFT_HZ,
    rightHz: RIGHT_HZ,
    durationMs: TEST_DURATION_MS,
  });

  console.log(`\nOutput: ${result.output}`);
  console.log(`Input:  ${result.input}`);
  console.log(`Captured ${result.capturedFrames} frames at ${result.sampleRate} Hz\n`);
  printMatrix(result);

  const leftSeparation = result.left.leftDb - result.left.rightDb;
  const rightSeparation = result.right.rightDb - result.right.leftDb;
  const leftPass = leftSeparation >= MIN_SEPARATION_DB;
  const rightPass = rightSeparation >= MIN_SEPARATION_DB;
  console.log(`\nLeft separation:  ${leftSeparation.toFixed(1)} dB ${leftPass ? 'PASS' : 'FAIL'}`);
  console.log(`Right separation: ${rightSeparation.toFixed(1)} dB ${rightPass ? 'PASS' : 'FAIL'}`);

  if (!leftPass || !rightPass) {
    console.error(`\nStereo routing failed: each channel should favor its intended tone by at least ${MIN_SEPARATION_DB} dB.`);
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`\nBlackHole stereo diagnostic failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await context.close();
}
