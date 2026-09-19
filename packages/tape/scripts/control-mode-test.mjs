#!/usr/bin/env node
// Unit tests for OpzControlMode (src/sync/opzControlMode.ts).
//
// All tests run inside a single page.evaluate() call in a headless browser so
// the Vite-bundled class is available without a separate TS build step.
// MIDIAccess is mocked entirely — no OP-Z, no MIDI permissions needed.
//
// Prerequisites:
//   npm run dev   (dev server must be running at http://localhost:5173)
//
// Run:
//   npm run test:control-mode

import { chromium } from 'playwright';

const APP_URL = 'http://localhost:5173';
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

async function waitFor(page, predicate, timeoutMs = 10_000, label = '') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await page.evaluate(predicate)) return;
    } catch { /* not yet */ }
    await page.waitForTimeout(100);
  }
  throw new Error(`Timeout waiting for: ${label}`);
}

// ---------------------------------------------------------------------------
// All assertions run inside the browser via page.evaluate so the
// Vite-bundled OpzControlMode class is available directly.
// ---------------------------------------------------------------------------
async function runBrowserTests(page) {
  return page.evaluate(() => {
    // ── Mock factory ────────────────────────────────────────────────────────
    // Creates a fresh mock MIDIAccess with one EventTarget-backed input and
    // one spy output.  A new mock per test keeps state independent.
    function makeMock() {
      class MockInput extends EventTarget {
        constructor() {
          super();
          this.id = 'mock-in';
          this.name = 'Mock Input';
          this.onmidimessage = null;
        }
      }
      const sentMessages = [];
      const mockOutput = {
        id: 'mock-out',
        name: 'Mock Output',
        send: (data) => sentMessages.push(Array.from(data)),
      };
      const input = new MockInput();
      const midiAccess = {
        inputs: new Map([['mock-in', input]]),
        outputs: new Map([['mock-out', mockOutput]]),
      };
      return { input, midiAccess, sentMessages };
    }

    // Dispatches a synthetic MIDIMessageEvent on an input EventTarget.
    function fire(input, status, d1, d2) {
      const bytes = d2 !== undefined ? [status, d1, d2] : [status, d1];
      const e = Object.assign(new Event('midimessage'), { data: new Uint8Array(bytes) });
      input.dispatchEvent(e);
    }

    const { OpzControlMode } = window.__tapeTest;
    const results = [];

    function test(name, fn) {
      try {
        const { pass, detail } = fn();
        results.push({ name, pass, detail: detail ?? '' });
      } catch (err) {
        results.push({ name, pass: false, detail: String(err) });
      }
    }

    // ── Channel filtering ───────────────────────────────────────────────────

    test('ignores Note On on channel 1 (not ch15)', () => {
      const { input, midiAccess } = makeMock();
      const ctrl = new OpzControlMode(midiAccess);
      ctrl.setInputDevice('all');
      const events = [];
      ctrl.on((e) => events.push(e));
      fire(input, 0x90, 54, 100); // ch1 Note On, same note as Lift
      ctrl.dispose();
      return { pass: events.length === 0, detail: JSON.stringify(events) };
    });

    test('ignores CC on channel 1 (not ch15)', () => {
      const { input, midiAccess } = makeMock();
      const ctrl = new OpzControlMode(midiAccess);
      ctrl.setInputDevice('all');
      const events = [];
      ctrl.on((e) => events.push(e));
      fire(input, 0xb0, 1, 70); // ch1 CC 1
      ctrl.dispose();
      return { pass: events.length === 0, detail: JSON.stringify(events) };
    });

    // ── Black-key control surface ──────────────────────────────────────────

    for (const [note, lane] of [[54, 0], [56, 1], [58, 2], [61, 3]]) {
      test(`Note ${note} → Tape ${lane + 1}`, () => {
        const { input, midiAccess } = makeMock();
        const ctrl = new OpzControlMode(midiAccess);
        ctrl.setInputDevice('all');
        const events = [];
        ctrl.on((e) => events.push(e));
        fire(input, 0x9e, note, 100);
        ctrl.dispose();
        const e = events[0];
        return {
          pass: events.length === 1 && e?.type === 'selectLane' && e?.lane === lane && e?.shift === false,
          detail: JSON.stringify(events),
        };
      });
    }

    for (const [note, type] of [[63, 'lift'], [66, 'drop'], [68, 'split']]) {
      test(`Note ${note} → ${type} { shift: false }`, () => {
        const { input, midiAccess } = makeMock();
        const ctrl = new OpzControlMode(midiAccess);
        ctrl.setInputDevice('all');
        const events = [];
        ctrl.on((e) => events.push(e));
        fire(input, 0x9e, note, 100);
        ctrl.dispose();
        const e = events[0];
        return {
          pass: events.length === 1 && e?.type === type && e?.shift === false,
          detail: JSON.stringify(events),
        };
      });
    }

    test('Note 70 → loop { shift: false }', () => {
      const { input, midiAccess } = makeMock();
      const ctrl = new OpzControlMode(midiAccess);
      ctrl.setInputDevice('all');
      const events = [];
      ctrl.on((e) => events.push(e));
      fire(input, 0x9e, 70, 100);
      ctrl.dispose();
      const e = events[0];
      return { pass: events.length === 1 && e?.type === 'loop' && e?.shift === false, detail: JSON.stringify(events) };
    });

    test('Note 73 → loopToggle { shift: false }', () => {
      const { input, midiAccess } = makeMock();
      const ctrl = new OpzControlMode(midiAccess);
      ctrl.setInputDevice('all');
      const events = [];
      ctrl.on((e) => events.push(e));
      fire(input, 0x9e, 73, 100);
      ctrl.dispose();
      const e = events[0];
      return {
        pass: events.length === 1 && e?.type === 'loopToggle' && e?.shift === false,
        detail: JSON.stringify(events),
      };
    });

    // ── White keys ignored ──────────────────────────────────────────────────

    test('White keys on ch15 produce no events', () => {
      const { input, midiAccess } = makeMock();
      const ctrl = new OpzControlMode(midiAccess);
      ctrl.setInputDevice('all');
      const events = [];
      ctrl.on((e) => events.push(e));
      // All natural (non-sharp) notes across octaves 3–5
      for (const n of [48, 50, 52, 53, 55, 57, 59, 60, 62, 64, 65, 67, 69, 71, 72, 74]) {
        fire(input, 0x9e, n, 100);
      }
      ctrl.dispose();
      return { pass: events.length === 0, detail: JSON.stringify(events) };
    });

    test('Unassigned black keys on ch15 produce no events', () => {
      const { input, midiAccess } = makeMock();
      const ctrl = new OpzControlMode(midiAccess);
      ctrl.setInputDevice('all');
      const events = [];
      ctrl.on((e) => events.push(e));
      // C#3 and D#3 are black keys not assigned to anything
      for (const n of [49, 51]) {
        fire(input, 0x9e, n, 100);
      }
      ctrl.dispose();
      return { pass: events.length === 0, detail: JSON.stringify(events) };
    });

    // ── Shift modifier ──────────────────────────────────────────────────────

    test('Note 75 Note On → shiftChange { held: true }', () => {
      const { input, midiAccess } = makeMock();
      const ctrl = new OpzControlMode(midiAccess);
      ctrl.setInputDevice('all');
      const events = [];
      ctrl.on((e) => events.push(e));
      fire(input, 0x9e, 75, 100);
      ctrl.dispose();
      return {
        pass: events.length === 1 && events[0]?.type === 'shiftChange' && events[0]?.held === true,
        detail: JSON.stringify(events),
      };
    });

    test('Note 75 Note Off (0x8E) → shiftChange { held: false }', () => {
      const { input, midiAccess } = makeMock();
      const ctrl = new OpzControlMode(midiAccess);
      ctrl.setInputDevice('all');
      const events = [];
      ctrl.on((e) => events.push(e));
      fire(input, 0x9e, 75, 100); // on
      fire(input, 0x8e, 75, 0);   // off
      ctrl.dispose();
      return {
        pass: events.length === 2 && events[1]?.type === 'shiftChange' && events[1]?.held === false,
        detail: JSON.stringify(events),
      };
    });

    test('Velocity-0 Note On on shift key is treated as Note Off', () => {
      const { input, midiAccess } = makeMock();
      const ctrl = new OpzControlMode(midiAccess);
      ctrl.setInputDevice('all');
      const events = [];
      ctrl.on((e) => events.push(e));
      fire(input, 0x9e, 75, 100); // on
      fire(input, 0x9e, 75, 0);   // vel 0 = note off
      ctrl.dispose();
      return {
        pass: events.length === 2 && events[1]?.type === 'shiftChange' && events[1]?.held === false,
        detail: JSON.stringify(events),
      };
    });

    test('isShiftHeld getter tracks state correctly', () => {
      const { input, midiAccess } = makeMock();
      const ctrl = new OpzControlMode(midiAccess);
      ctrl.setInputDevice('all');
      const before = ctrl.isShiftHeld;          // false
      fire(input, 0x9e, 75, 100);
      const during = ctrl.isShiftHeld;          // true
      fire(input, 0x8e, 75, 0);
      const after = ctrl.isShiftHeld;           // false
      ctrl.dispose();
      return {
        pass: before === false && during === true && after === false,
        detail: `before=${before} during=${during} after=${after}`,
      };
    });

    test('Lift while shift held → lift { shift: true }', () => {
      const { input, midiAccess } = makeMock();
      const ctrl = new OpzControlMode(midiAccess);
      ctrl.setInputDevice('all');
      const events = [];
      ctrl.on((e) => events.push(e));
      fire(input, 0x9e, 75, 100); // shift on  → shiftChange
      fire(input, 0x9e, 63, 100); // lift
      ctrl.dispose();
      const lift = events[1];
      return {
        pass: events.length === 2 && lift?.type === 'lift' && lift?.shift === true,
        detail: JSON.stringify(events),
      };
    });

    test('Tape 4 while shift held → selectLane { lane: 3, shift: true }', () => {
      const { input, midiAccess } = makeMock();
      const ctrl = new OpzControlMode(midiAccess);
      ctrl.setInputDevice('all');
      const events = [];
      ctrl.on((e) => events.push(e));
      fire(input, 0x9e, 75, 100); // shift on
      fire(input, 0x9e, 61, 100); // Tape 4
      ctrl.dispose();
      const selectLane = events[1];
      return {
        pass: events.length === 2 && selectLane?.type === 'selectLane' && selectLane?.lane === 3 && selectLane?.shift === true,
        detail: JSON.stringify(events),
      };
    });

    test('Loop while shift held → loop { shift: true }', () => {
      const { input, midiAccess } = makeMock();
      const ctrl = new OpzControlMode(midiAccess);
      ctrl.setInputDevice('all');
      const events = [];
      ctrl.on((e) => events.push(e));
      fire(input, 0x9e, 75, 100);
      fire(input, 0x9e, 70, 100);
      ctrl.dispose();
      const ev = events[1];
      return {
        pass: events.length === 2 && ev?.type === 'loop' && ev?.shift === true,
        detail: JSON.stringify(events),
      };
    });

    test('CC 4 enables from off on any non-zero value and mirrors the max endpoint', () => {
      const { input, midiAccess, sentMessages } = makeMock();
      const ctrl = new OpzControlMode(midiAccess);
      ctrl.setInputDevice('all');
      ctrl.setOutputDevice('mock-out');
      const events = [];
      ctrl.on((e) => events.push(e));
      fire(input, 0xbe, 4, 1);
      ctrl.setRecordEnabled(true);
      ctrl.dispose();
      return {
        pass: events[0]?.type === 'recordState' && events[0]?.enabled === true &&
          sentMessages.some((m) => m[0] === 0xbe && m[1] === 4 && m[2] === 127),
        detail: `events=${JSON.stringify(events)} sent=${JSON.stringify(sentMessages)}`,
      };
    });

    test('CC 4 disables from on on any value below the max endpoint', () => {
      const { input, midiAccess, sentMessages } = makeMock();
      const ctrl = new OpzControlMode(midiAccess);
      ctrl.setInputDevice('all');
      ctrl.setOutputDevice('mock-out');
      const events = [];
      ctrl.on((e) => events.push(e));
      ctrl.setRecordEnabled(true);
      fire(input, 0xbe, 4, 126);
      ctrl.setRecordEnabled(false);
      ctrl.dispose();
      return {
        pass: events[0]?.type === 'recordState' && events[0]?.enabled === false &&
          sentMessages.some((m) => m[0] === 0xbe && m[1] === 4 && m[2] === 0),
        detail: `events=${JSON.stringify(events)} sent=${JSON.stringify(sentMessages)}`,
      };
    });

    test('Shift plus MIDI Stop emits grid', () => {
      const { input, midiAccess } = makeMock();
      const ctrl = new OpzControlMode(midiAccess);
      ctrl.setInputDevice('all');
      const events = [];
      ctrl.on((e) => events.push(e));
      fire(input, 0x9e, 75, 100);
      fire(input, 0xfc, 0);
      ctrl.dispose();
      return { pass: events[1]?.type === 'grid', detail: JSON.stringify(events) };
    });

    test('Loop Toggle while shift held → loopToggle { shift: true }', () => {
      const { input, midiAccess } = makeMock();
      const ctrl = new OpzControlMode(midiAccess);
      ctrl.setInputDevice('all');
      const events = [];
      ctrl.on((e) => events.push(e));
      fire(input, 0x9e, 75, 100);
      fire(input, 0x9e, 73, 100);
      ctrl.dispose();
      const ev = events[1];
      return {
        pass: events.length === 2 && ev?.type === 'loopToggle' && ev?.shift === true,
        detail: JSON.stringify(events),
      };
    });

    // ── Encoder CC (absolute → relative) ───────────────────────────────────

    test('CC 1: 64→70 emits encoderDelta { index:0, delta:6, shift:false }', () => {
      const { input, midiAccess } = makeMock();
      const ctrl = new OpzControlMode(midiAccess);
      ctrl.setInputDevice('all');
      const events = [];
      ctrl.on((e) => events.push(e));
      fire(input, 0xbe, 1, 70); // starts at centre 64, delta = +6
      ctrl.dispose();
      const e = events[0];
      return {
        pass: e?.type === 'encoderDelta' && e?.index === 0 && e?.delta === 6 && e?.shift === false,
        detail: JSON.stringify(e),
      };
    });

    test('CC 2: 64→50 emits encoderDelta { index:1, delta:-14, shift:false }', () => {
      const { input, midiAccess } = makeMock();
      const ctrl = new OpzControlMode(midiAccess);
      ctrl.setInputDevice('all');
      const events = [];
      ctrl.on((e) => events.push(e));
      fire(input, 0xbe, 2, 50);
      ctrl.dispose();
      const e = events[0];
      return {
        pass: e?.type === 'encoderDelta' && e?.index === 1 && e?.delta === -14,
        detail: JSON.stringify(e),
      };
    });

    test('CC 3 maps to encoder index 2 while CC 4 is not an encoder delta', () => {
      const { input, midiAccess } = makeMock();
      const ctrl = new OpzControlMode(midiAccess);
      ctrl.setInputDevice('all');
      const events = [];
      ctrl.on((e) => events.push(e));
      fire(input, 0xbe, 3, 66); // delta +2
      fire(input, 0xbe, 4, 60); // enables record state from off
      ctrl.dispose();
      return {
        pass: events[0]?.type === 'encoderDelta' && events[0]?.index === 2 &&
          events[1]?.type === 'recordState' && events[1]?.enabled === true,
        detail: JSON.stringify(events),
      };
    });

    test('Two consecutive CC moves accumulate from last value', () => {
      const { input, midiAccess } = makeMock();
      const ctrl = new OpzControlMode(midiAccess);
      ctrl.setInputDevice('all');
      const events = [];
      ctrl.on((e) => events.push(e));
      fire(input, 0xbe, 1, 68); // delta +4 from 64
      fire(input, 0xbe, 1, 72); // delta +4 from 68
      ctrl.dispose();
      return {
        pass: events[0]?.delta === 4 && events[1]?.delta === 4,
        detail: JSON.stringify(events),
      };
    });

    test('CC 5 (not an encoder) is ignored', () => {
      const { input, midiAccess } = makeMock();
      const ctrl = new OpzControlMode(midiAccess);
      ctrl.setInputDevice('all');
      const events = [];
      ctrl.on((e) => events.push(e));
      fire(input, 0xbe, 5, 70);
      ctrl.dispose();
      return { pass: events.length === 0, detail: JSON.stringify(events) };
    });

    test('Encoder with shift held emits encoderDelta { shift: true }', () => {
      const { input, midiAccess } = makeMock();
      const ctrl = new OpzControlMode(midiAccess);
      ctrl.setInputDevice('all');
      const events = [];
      ctrl.on((e) => events.push(e));
      fire(input, 0x9e, 75, 100); // shift on
      fire(input, 0xbe, 2, 70);   // blue encoder move
      ctrl.dispose();
      const enc = events[1];
      return {
        pass: enc?.type === 'encoderDelta' && enc?.shift === true,
        detail: JSON.stringify(events),
      };
    });

    // ── Encoder reset ───────────────────────────────────────────────────────

    test('CC drifting >30 from centre (64) sends reset CC to output', () => {
      const { input, midiAccess, sentMessages } = makeMock();
      const ctrl = new OpzControlMode(midiAccess);
      ctrl.setInputDevice('all');
      ctrl.setOutputDevice('mock-out');
      const events = [];
      ctrl.on((e) => events.push(e));
      fire(input, 0xbe, 1, 95); // 95 − 64 = 31 > threshold 30
      ctrl.dispose();
      const deltaEmitted = events.some((e) => e.type === 'encoderDelta' && e.delta === 31);
      const resetSent = sentMessages.some((m) => m[0] === 0xbe && m[1] === 1 && m[2] === 64);
      return {
        pass: deltaEmitted && resetSent,
        detail: `events=${JSON.stringify(events)} sent=${JSON.stringify(sentMessages)}`,
      };
    });

    test('CC within threshold (≤30 from 64) does NOT send reset', () => {
      const { input, midiAccess, sentMessages } = makeMock();
      const ctrl = new OpzControlMode(midiAccess);
      ctrl.setInputDevice('all');
      ctrl.setOutputDevice('mock-out');
      ctrl.on(() => {});
      fire(input, 0xbe, 1, 93); // 93 − 64 = 29, within threshold
      ctrl.dispose();
      return { pass: sentMessages.length === 0, detail: JSON.stringify(sentMessages) };
    });

    test('After reset, next delta is measured from recentred value (64)', () => {
      const { input, midiAccess } = makeMock();
      const ctrl = new OpzControlMode(midiAccess);
      ctrl.setInputDevice('all');
      ctrl.setOutputDevice('mock-out');
      const events = [];
      ctrl.on((e) => events.push(e));
      fire(input, 0xbe, 1, 95); // triggers reset → internal tracking resets to 64
      fire(input, 0xbe, 1, 68); // next delta: 68 − 64 = 4
      ctrl.dispose();
      return {
        pass: events[1]?.delta === 4,
        detail: `second delta=${events[1]?.delta}, events=${JSON.stringify(events)}`,
      };
    });

    test('No reset sent when no output device is selected', () => {
      const { input, midiAccess, sentMessages } = makeMock();
      const ctrl = new OpzControlMode(midiAccess);
      ctrl.setInputDevice('all');
      // intentionally NOT calling setOutputDevice
      ctrl.on(() => {});
      fire(input, 0xbe, 1, 95); // would trigger reset, but no output selected
      ctrl.dispose();
      return { pass: sentMessages.length === 0, detail: JSON.stringify(sentMessages) };
    });

    // ── Dispose ─────────────────────────────────────────────────────────────

    test('After dispose(), events no longer fire', () => {
      const { input, midiAccess } = makeMock();
      const ctrl = new OpzControlMode(midiAccess);
      ctrl.setInputDevice('all');
      const events = [];
      ctrl.on((e) => events.push(e));
      ctrl.dispose();
      fire(input, 0x9e, 54, 100); // fired after dispose
      return { pass: events.length === 0, detail: JSON.stringify(events) };
    });

    return results;
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  console.log('\n=== OpzControlMode Unit Tests ===\n');

  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });

    // Wait for React to mount and set up __tapeTest (happens on first render,
    // before any audio is enabled — no permission prompts needed).
    await waitFor(
      page,
      () => typeof window.__tapeTest?.OpzControlMode === 'function',
      10_000,
      'window.__tapeTest.OpzControlMode available',
    );

    const results = await runBrowserTests(page);

    let section = null;
    for (const r of results) {
      assert(r.pass, r.name, r.detail);
    }
  } catch (err) {
    console.error('\nFatal:', err.message);
    failed++;
  } finally {
    await browser.close();
  }

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
