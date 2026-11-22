#!/usr/bin/env node
// Run against the local Loop Pad dev server.
import { chromium } from 'playwright';

const appUrl = process.env.LOOP_PAD_URL ?? 'http://localhost:5173/tape/loop-pad/';
const browser = await chromium.launch({
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
try {
  const page = await browser.newPage();
  await page.goto(appUrl);
  const result = await page.evaluate(async () => {
    const { SamplerEngine } = await import('/tape/loop-pad/src/audio/samplerEngine.ts');
    const { makeDefaultProject } = await import('/tape/loop-pad/src/sampler/model.ts');
    const { encodeProject, decodeProject } = await import('/tape/loop-pad/src/sampler/projectCodec.ts');
    const originalGetUserMedia = navigator.mediaDevices.getUserMedia;
    const originalCreateSource = AudioContext.prototype.createMediaStreamSource;
    const track = { getCapabilities: () => ({ channelCount: { max: 4 } }), getSettings: () => ({ channelCount: 4 }), stop() {} };
    const stream = { getAudioTracks: () => [track], getTracks: () => [track] };
    navigator.mediaDevices.getUserMedia = async () => stream;
    AudioContext.prototype.createMediaStreamSource = function () {
      const merger = this.createChannelMerger(4);
      const oscillator = this.createOscillator();
      oscillator.frequency.value = 1000;
      for (const [channel, level] of [0.1, 0.05, 0.2, 0.025].entries()) {
        const gain = this.createGain();
        gain.gain.value = level;
        oscillator.connect(gain).connect(merger, 0, channel);
      }
      oscillator.start();
      return merger;
    };
    const engine = new SamplerEngine();
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const peak = (analyser) => {
      const buffer = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(buffer);
      return Math.max(...buffer.map(Math.abs));
    };
    const closeTo = (actual, expected, label) => {
      if (Math.abs(actual - expected) > 0.01) throw new Error(`${label}: got ${actual}, expected ${expected}`);
    };
    try {
      await engine.init();
      await engine.audioContext.resume();
      if (engine.inputChannels !== 4) throw new Error(`Expected four input channels, got ${engine.inputChannels}`);
      engine.setMonitor(true, -1);
      await wait(250);
      closeTo(peak(engine.inputLevelAnalysers.left), 0.1, 'stereo input left');
      closeTo(peak(engine.inputLevelAnalysers.right), 0.05, 'stereo input right');
      closeTo(peak(engine.masterLevelAnalysers.left), 0.15, 'stereo monitor sum');

      engine.setInputChannel(5); // channel 3 mono
      await wait(250);
      closeTo(peak(engine.inputLevelAnalysers.left), 0.2, 'mono input meter');
      closeTo(peak(engine.inputLevelAnalysers.right), 0, 'unused mono input meter');
      closeTo(peak(engine.masterLevelAnalysers.left), 0.2, 'mono monitor');
      engine.startRecording(0);
      await wait(700);
      const samples = await engine.stopRecording(0);
      if (!samples.mono) throw new Error('Mono recording lost its channel identity');
      const project = makeDefaultProject();
      project.banks[0][0].sample = { samples, sampleRate: engine.sampleRate, peaks: [], takeStatus: 'finalized' };
      const restored = decodeProject(encodeProject(project));
      const restoredSamples = restored.banks[0][0].sample.samples;
      if (!restoredSamples.mono) throw new Error('Mono identity lost on project restore');
      engine.loadSlotBuffer(0, restoredSamples);
      engine.setMonitor(false, -1);
      engine.play(0, { level: 1, pan: -1, lpfCutoff: 1, hpfCutoff: 0 }, 0);
      await wait(200);
      closeTo(peak(engine.masterLevelAnalysers.left), 0.2, 'mono playback');

      engine.setInputChannel(4); // channels 3-4 stereo
      engine.setMonitor(true, 1);
      await wait(250);
      closeTo(peak(engine.masterLevelAnalysers.right), 0.225, 'stereo monitor on channel B');

      let outputChannels = 2;
      let destinationChannels = 2;
      Object.defineProperties(engine.audioContext.destination, {
        maxChannelCount: { configurable: true, get: () => outputChannels },
        channelCount: {
          configurable: true,
          get: () => destinationChannels,
          set: (value) => { destinationChannels = value; },
        },
      });
      engine.audioContext.setSinkId = async (id) => {
        if (id === 'failed') throw new Error('device unavailable');
        outputChannels = id === 'six' ? 6 : 2;
      };
      await engine.setOutputDevice('six');
      if (engine.outputChannels !== 6 || destinationChannels !== 6) throw new Error('Six-channel output was not configured');
      engine.setOutputChannelPair(4);
      await wait(250);
      closeTo(peak(engine.masterLevelAnalysers.right), 0.225, 'monitor on output channels 5-6');
      engine.playCountInClicks(2, 0.5);
      await engine.setOutputDevice('two');
      engine.stopCountInClicks();
      if (engine.outputChannels !== 2 || destinationChannels !== 2 || engine.selectedOutputChannelPairStart !== 0) {
        throw new Error('Switching to stereo did not reset the output pair');
      }
      await wait(250);
      closeTo(peak(engine.masterLevelAnalysers.right), 0.225, 'monitor after switching to stereo');
      await engine.setOutputDevice('six');
      engine.setOutputChannelPair(4);
      await wait(250);
      closeTo(peak(engine.masterLevelAnalysers.right), 0.225, 'monitor after switching back to six channels');
      engine.setMonitor(false, 0);
      const tone = Float32Array.from({ length: engine.sampleRate * 2 }, (_, index) =>
        0.1 * Math.sin(2 * Math.PI * 1000 * index / engine.sampleRate));
      engine.loadSlotBuffer(1, { left: tone, right: tone });
      engine.play(1, { level: 1, pan: 0, lpfCutoff: 1, hpfCutoff: 0 }, 0);
      await wait(150);
      if (peak(engine.masterLevelAnalysers.right) < 0.05) throw new Error('Voice did not reach channels 5-6');
      await engine.setOutputDevice('two');
      await wait(150);
      if (peak(engine.masterLevelAnalysers.right) < 0.05) throw new Error('Active voice was lost after output switch');
      await engine.setOutputDevice('six');
      try {
        await engine.setOutputDevice('failed');
        throw new Error('Failed sink selection unexpectedly succeeded');
      } catch (error) {
        if (error.message !== 'device unavailable') throw error;
      }
      if (engine.outputDeviceId !== 'six' || engine.outputChannels !== 6) throw new Error('Failed sink selection changed output state');

      // LPP3 has no mono byte; convert an LPP4 project containing stereo audio.
      const legacyProject = makeDefaultProject();
      legacyProject.banks[0][0].sample = {
        samples: { left: new Float32Array([0.25, -0.5]), right: new Float32Array([0.75, -0.25]) },
        sampleRate: 48000, peaks: [], takeStatus: 'unfinalized',
      };
      const encoded = encodeProject(legacyProject);
      const legacy = new Uint8Array(encoded.length - 32);
      legacy.set(new TextEncoder().encode('LPP3'));
      let source = 4;
      let target = 4;
      for (let slot = 0; slot < 32; slot++) {
        legacy.set(encoded.subarray(source, source + 2), target);
        const frames = encoded[source] === 1 ? new DataView(encoded.buffer).getUint32(source + 23, true) : 0;
        const payloadLength = frames > 0 ? 4 + frames * 8 : 0;
        legacy.set(encoded.subarray(source + 3, source + 23 + payloadLength), target + 2);
        source += 23 + payloadLength;
        target += 22 + payloadLength;
      }
      const legacySample = decodeProject(legacy).banks[0][0].sample;
      if (!legacySample || legacySample.samples.mono || legacySample.takeStatus !== 'unfinalized'
        || legacySample.samples.left[1] !== -0.5 || legacySample.samples.right[0] !== 0.75) {
        throw new Error('Legacy stereo sample did not load correctly');
      }
      return 'Stereo and mono metering, monitoring, recording, playback, persistence, and legacy loading passed';
    } finally {
      await engine.dispose();
      navigator.mediaDevices.getUserMedia = originalGetUserMedia;
      AudioContext.prototype.createMediaStreamSource = originalCreateSource;
    }
  });
  console.log(result);

  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  await context.grantPermissions(['microphone'], { origin: new URL(appUrl).origin });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'requestMIDIAccess', {
      configurable: true,
      value: async () => ({ inputs: new Map(), outputs: new Map() }),
    });
    const NativeAudioContext = window.AudioContext;
    window.AudioContext = class extends NativeAudioContext {
      constructor(options) {
        super(options);
        window.testAudioContext = this;
        Object.defineProperty(this, 'renderQuantumSize', { configurable: true, value: 64 });
      }
    };
  });
  const ui = await context.newPage();
  await ui.goto(appUrl);
  await ui.getByRole('button', { name: 'Settings' }).waitFor();
  await ui.getByRole('button', { name: 'Settings' }).click();
  const sampleRate = await ui.evaluate(() => window.testAudioContext.sampleRate);
  if (await ui.getByLabel('Audio Sample Rate').textContent() !== `${sampleRate} Hz`) {
    throw new Error('Settings did not show the audio context sample rate');
  }
  if (await ui.getByLabel('Audio Render Block Size').textContent() !== '64 frames') {
    throw new Error('Settings did not show the reported render block size');
  }
  await ui.evaluate(() => Object.defineProperty(window.testAudioContext, 'renderQuantumSize', { value: undefined }));
  await ui.getByRole('button', { name: 'Close' }).click();
  await ui.getByRole('button', { name: 'Settings' }).click();
  if (await ui.getByLabel('Audio Render Block Size').textContent() !== 'Unavailable') {
    throw new Error('Unavailable render block size was not reported');
  }
  await ui.getByLabel('Input Channels').selectOption({ label: '1-2 (stereo)' });
  const input = ui.getByLabel('Input level');
  const stereoStrip = await input.locator(':scope > div').first().boundingBox();
  await ui.getByLabel('Input Channels').selectOption({ label: '1 (mono)' });
  await ui.getByRole('button', { name: 'Close' }).click();
  const master = ui.getByLabel('Master level');
  if (await input.locator(':scope > div').count() !== 1) throw new Error('Mono input meter must display one column');
  const monoStrip = await input.locator(':scope > div').first().boundingBox();
  if (!stereoStrip || !monoStrip || Math.abs(stereoStrip.width - monoStrip.width) > 0.1) {
    throw new Error(`Mono and stereo strip widths differ: ${JSON.stringify({ stereoStrip, monoStrip })}`);
  }
  const inputBox = await input.boundingBox();
  const masterBox = await master.boundingBox();
  if (!inputBox || !masterBox || Math.abs(inputBox.y - masterBox.y) > 0.1 || Math.abs(inputBox.height - masterBox.height) > 0.1) {
    throw new Error(`Input and master meters are not aligned: ${JSON.stringify({ inputBox, masterBox })}`);
  }
  await ui.reload();
  await ui.getByRole('button', { name: 'Settings' }).waitFor();
  if (await input.locator(':scope > div').count() !== 1) throw new Error('Mono selection was not restored');
  console.log('Mono meter display, alignment, and selection persistence passed');
  await context.close();

  const outputContext = await browser.newContext();
  await outputContext.grantPermissions(['microphone'], { origin: new URL(appUrl).origin });
  await outputContext.addInitScript(() => {
    Object.defineProperty(navigator, 'requestMIDIAccess', {
      configurable: true,
      value: async () => ({ inputs: new Map(), outputs: new Map() }),
    });
    const enumerate = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
    navigator.mediaDevices.enumerateDevices = async () => [
      ...(await enumerate()).filter((device) => device.kind !== 'audiooutput'),
      { kind: 'audiooutput', deviceId: 'six', label: 'Six channel output' },
      { kind: 'audiooutput', deviceId: 'two', label: 'Stereo output' },
      { kind: 'audiooutput', deviceId: 'failed', label: 'Unavailable output' },
    ];
    const NativeAudioContext = window.AudioContext;
    window.AudioContext = class extends NativeAudioContext {
      constructor(options) {
        super(options);
        let channels = 6;
        let destinationChannels = 2;
        Object.defineProperties(this.destination, {
          maxChannelCount: { configurable: true, get: () => channels },
          channelCount: {
            configurable: true,
            get: () => destinationChannels,
            set: (value) => { destinationChannels = value; },
          },
        });
        this.setSinkId = async (id) => {
          if (id === 'failed') throw new Error('device unavailable');
          channels = id === 'two' ? 2 : 6;
        };
      }
    };
  });
  const outputPage = await outputContext.newPage();
  await outputPage.goto(appUrl);
  await outputPage.getByRole('button', { name: 'Settings' }).click();
  const output = outputPage.getByLabel('Audio Output');
  const pair = outputPage.getByLabel('Output Channels');
  await output.selectOption('six');
  await pair.selectOption({ label: '5-6' });
  await output.selectOption('two');
  await pair.waitFor({ state: 'hidden' });
  await output.selectOption('six');
  await pair.waitFor({ state: 'visible' });
  if (await pair.inputValue() !== '4') throw new Error('Available remembered output pair was not restored');
  await output.selectOption('failed');
  await outputPage.getByRole('alert').getByText('Could not select audio output: device unavailable').waitFor();
  if (await output.inputValue() !== 'six') throw new Error('Failed output selection changed the displayed device');
  console.log('Output device channel switching, pair restoration, and error reporting passed');
  await outputContext.close();
} finally {
  await browser.close();
}
