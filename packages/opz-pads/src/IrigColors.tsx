import { useEffect, useRef, useState } from 'react';
import { gradients, off, palette } from './irig-colors.ts';
import { buttonLedMessages, padLedMessages } from './irig.ts';
import { flipPadIndex } from './irig-midi.ts';

type Props = {
  send: (bytes: number[]) => void;
  restoreLeds: () => void;
  reportError: (message: string) => void;
};

export function IrigColors({ send, restoreLeds, reportError }: Props) {
  const [mode, setMode] = useState<'palette' | 'gradient'>('palette');
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [gradientIndex, setGradientIndex] = useState(0);
  const [value, setValue] = useState(0);
  const [target, setTarget] = useState('pad');
  const [number, setNumber] = useState(1);
  const [error, setError] = useState('');
  const touched = useRef({ pads: false, buttons: new Set<number>() });
  const color = mode === 'palette' ? palette[paletteIndex].color : gradients[gradientIndex].color(value);

  useEffect(() => () => {
    const errors: string[] = [];
    for (const index of touched.current.buttons) {
      for (const bytes of buttonLedMessages(index, off)) {
        try {
          send(bytes);
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
        }
      }
    }
    if (touched.current.pads) restoreLeds();
    touched.current = { pads: false, buttons: new Set() };
    if (errors.length) reportError(`Could not clear color explorer buttons: ${errors.join('; ')}`);
  }, [send, restoreLeds, reportError]);

  function sendColor(): void {
    const index = number - 1;
    if (target === 'pad') touched.current.pads = true;
    else touched.current.buttons.add(index);
    const messages = target === 'pad' ? padLedMessages(flipPadIndex(index), color) : buttonLedMessages(index, color);
    try {
      for (const bytes of messages) send(bytes);
      setError('');
    } catch (error) {
      setError(`Could not send color: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return <div className="irig-colors">
    <p>Choose an app color and send it to a physical pad or button. The preview is approximate;
      check the hardware for the actual color.</p>
    <label>Color source <select value={mode} onChange={(event) => setMode(event.currentTarget.value === 'gradient' ? 'gradient' : 'palette')}>
      <option value="palette">Palette</option><option value="gradient">Gradient</option>
    </select></label>
    {mode === 'palette' ? <label>Palette color <select value={paletteIndex}
      onChange={(event) => setPaletteIndex(Number(event.currentTarget.value))}>
      {palette.map((entry, index) => <option key={entry.name} value={index}>{entry.name}</option>)}
    </select></label> : <>
      <label>Gradient <select aria-label="Gradient" value={gradientIndex} onChange={(event) => setGradientIndex(Number(event.currentTarget.value))}>
        {gradients.map((entry, index) => <option key={entry.name} value={index}>{entry.name}</option>)}
      </select></label>
      <label>Gradient position <input type="range" min="0" max="127" value={value}
        onChange={(event) => setValue(Number(event.currentTarget.value))} /> {value}</label>
    </>}
    <p><span className="irig-color-preview" aria-hidden="true"
      style={{ backgroundColor: `rgb(${color[0] * 2}, ${color[1] * 2}, 0)` }} />
      Red {color[0]}, green {color[1]}</p>
    <label>Target <select value={target} onChange={(event) => { setTarget(event.currentTarget.value); setNumber(1); }}>
      <option value="pad">Pad</option><option value="button">Button</option>
    </select></label>
    <label>Physical {target} <select value={number} onChange={(event) => setNumber(Number(event.currentTarget.value))}>
      {Array.from({ length: target === 'pad' ? 16 : 2 }, (_, index) =>
        <option key={index} value={index + 1}>{index + 1}</option>)}
    </select></label>
    <button type="button" onClick={sendColor}>Send color</button>
    {error && <p role="alert" className="check-warning">{error}</p>}
  </div>;
}
