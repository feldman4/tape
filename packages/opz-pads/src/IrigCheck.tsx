import { useEffect, useReducer } from 'react';
import type { RefObject } from 'react';
import { checkReducer, controls, gestures, initialCheck } from './irig-check.ts';
import type { Step } from './irig-check.ts';
import { startLedSequence } from './irig.ts';
import { IRIG_MIDI, isSceneButtonCC } from './irig-midi.ts';

type Props = {
  ready: boolean;
  inputRef: RefObject<((bytes: Uint8Array) => void) | null>;
  send: (bytes: number[]) => void;
  restoreLeds: () => void;
  reportError: (message: string) => void;
};

const headings: Record<Step, string> = {
  scene: 'Scene selection',
  pads: 'Pads and pressure',
  simultaneous: 'Simultaneous holds',
  controls: 'Controls and modifiers',
  gestures: 'Combined gestures',
  leds: 'LED output',
};
const steps: Step[] = ['scene', 'pads', 'simultaneous', 'controls', 'gestures', 'leds'];

export function IrigCheck({ ready, inputRef, send, restoreLeds, reportError }: Props) {
  const [state, dispatch] = useReducer(checkReducer, initialCheck);

  useEffect(() => {
    inputRef.current = (bytes) => dispatch({ type: 'midi', bytes: Array.from(bytes) });
    return () => { inputRef.current = null; };
  }, [inputRef]);

  useEffect(() => {
    if (!state.ledRunning || !ready) return;
    const stop = startLedSequence(send, () => dispatch({ type: 'led-sent' }),
      (message) => dispatch({ type: 'led-error', message }));
    return () => {
      try {
        stop();
      } catch (error) {
        reportError(`Could not clear LED test: ${error instanceof Error ? error.message : String(error)}`);
      }
      restoreLeds();
    };
  }, [state.ledRunning, ready, send, restoreLeds, reportError]);

  const simultaneousInstructions = [
    'Press and hold pad 1.', 'Keep pad 1 held and press pad 2.',
    'Keep pad 2 held and release pad 1.', 'Release pad 2.',
  ];
  const control = controls[state.control];
  const completed: Record<Step, boolean> = {
    scene: state.sceneSeen,
    pads: state.pad === 16,
    simultaneous: state.simultaneous === 4,
    controls: state.control === controls.length,
    gestures: state.gesture === gestures.length,
    leds: state.ledComplete,
  };

  return <section className="irig-check">
    <h2>iRig bidirectional check</h2>
    <p>Allow MIDI access and select the iRig input and output above. An OP-Z is not required.
      Testing does not play notes or edit your project. Test each programmed scene separately;
      this checks only the scene selected below.</p>
    <p>Before starting, program the scene as described in the manual. Factory defaults differ.
      Use the physical SCENE button to recall it; do not hold SCENE to store or erase a scene.</p>
    {!ready ? <p role="status" className="check-warning">Select connected, distinct iRig and OP-Z inputs and a connected iRig output.
      The OP-Z input may be left unselected.</p> : <>
      <label>Scene to check <select value={state.scene} onChange={(event) =>
        dispatch({ type: 'scene', scene: Number(event.currentTarget.value) })}>
        {Array.from({ length: 16 }, (_, index) => <option key={index} value={index + 1}>{index + 1}</option>)}
      </select></label>
      <p>Choose any check below. Changing the scene resets all checks.</p>
      <ul className="check-list" aria-label="iRig checks">
        {steps.map((step) => <li key={step}><button type="button" aria-pressed={state.step === step}
          aria-label={`${headings[step]}, ${completed[step] ? 'complete' : 'not complete'}`}
          onClick={() => dispatch({ type: 'select', step })}>
          <span aria-hidden="true" className={completed[step] ? 'check-complete' : ''}>{completed[step] ? '✓' : '○'}</span>
          {' '}{headings[step]}
        </button></li>)}
      </ul>
      {steps.every((step) => completed[step]) && <p role="status">Scene {state.scene} passed all checks.
        This does not verify other scenes or automatically prove the hardware displayed the LED patterns.</p>}
      <h2>{headings[state.step]}</h2>
      {state.step === 'scene' && <>
        <p>On the iRig, recall scene {state.scene}, then press and release button 1 or 2.
          Expected: CC {IRIG_MIDI.cc.button1} or {IRIG_MIDI.cc.button2} on channel {state.scene}, with value
          {' '}{IRIG_MIDI.buttonPressed} when pressed and {IRIG_MIDI.buttonReleased} when released.</p>
        <p>{state.sceneSeen ? 'Matching button press and release received.' : 'Waiting for matching button press and release.'}</p>
      </>}
      {state.step === 'pads' && <>
        {state.pad < 16 ? <p>Pad {state.pad + 1} of 16: {state.padPhase === 'press'
          ? 'press and hold' : state.padPhase === 'pressure'
            ? 'keep holding and vary pressure' : 'release'}. Expected note {IRIG_MIDI.padNote} on channel {state.pad + 1}
          {state.padPhase === 'pressure' ? ', then channel aftertouch on the same channel' : ''}.</p>
          : <p>All 16 pads sent note-on, channel pressure, and note-off on their expected channels.</p>}
      </>}
      {state.step === 'simultaneous' && <>
        <p>{state.simultaneous < 4 ? simultaneousInstructions[state.simultaneous] : 'Both pads were held and released independently.'}</p>
      </>}
      {state.step === 'controls' && <>
        {control ? <p>{control.kind === 'button'
          ? `${state.pressed ? 'Release' : 'Press and hold'} ${control.label}`
          : `Move ${control.label}`}. Expected channel {state.scene}, CC {control.cc}
          {isSceneButtonCC(control.cc) || control.cc === IRIG_MIDI.cc.dataPush
            ? `, value ${IRIG_MIDI.buttonPressed} pressed, ${IRIG_MIDI.buttonReleased} released` : ''}
          {control.kind === 'positive' ? ', value 1–63' : control.kind === 'negative' ? ', value 64–127' : ''}.</p>
          : <p>All configured controls produced the expected messages.</p>}
      </>}
      {state.step === 'gestures' && <>
        <p>{gestures[state.gesture]?.instruction ?? 'Pad/modifier and DATA push-turn combinations received.'}</p>
        <p>Release everything and start the current combination again if a held control is released early.</p>
      </>}
      {state.step === 'leds' && <>
        <p>Watch the physical iRig for about 10 seconds. Each pad and buttons 1 and 2
          cycle from dim green through bright green, yellow and bright red to dim red.</p>
        <button disabled={state.ledRunning} onClick={() => dispatch({ type: 'led-start' })}>Start LED sequence</button>{' '}
        <button disabled={!state.ledSent} onClick={() => dispatch({ type: 'led-confirm' })}>Yes, it matches</button>{' '}
        <button disabled={!state.ledSent} onClick={() => dispatch({ type: 'led-error',
          message: 'Not verified. Check the output port and device mode, then run the sequence again.' })}>No, it does not match</button>
        {state.ledError && <p role="alert" className="check-warning">{state.ledError}</p>}
        {state.ledRunning && <p role="status">LED sequence running...</p>}
        {state.ledSent && <p>Sequence finished; did all pads and both buttons match?</p>}
        {state.ledComplete && <p>LED sequence visually confirmed.</p>}
      </>}
      <button onClick={() => dispatch({ type: 'restart-check' })}>Restart this check</button>
      <h2>Last iRig MIDI message</h2>
      <p className="midi-message" aria-live="polite">{state.last}</p>
      <p>If a step does not progress, compare the raw message above with the expected channel, note or CC.
        Confirm the selected ports, scene programming and device mode, then try again.</p>
    </>}
  </section>;
}
