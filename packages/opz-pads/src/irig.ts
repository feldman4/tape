import type { Led } from './scenes.ts';
import { IRIG_MIDI } from './irig-midi.ts';

function ledMessages(greenCC: number, [red, green]: Led): [number[], number[]] {
  return [[0xb0 + IRIG_MIDI.ledChannel, greenCC, green],
    [0xb0 + IRIG_MIDI.ledChannel, greenCC + 1, red]];
}

export function padLedMessages(index: number, [red, green]: Led): [number[], number[]] {
  return ledMessages(IRIG_MIDI.padGreenLedCCs[index], [red, green]);
}

export function buttonLedMessages(index: number, color: Led): [number[], number[]] {
  return ledMessages(IRIG_MIDI.buttonGreenLedCCs[index], color);
}

export function startLedSequence(
  send: (bytes: number[]) => void, onComplete: () => void, onError: (message: string) => void,
): () => void {
  const colors: Led[] = [[0, 32], [0, 127], [32, 96], [64, 64], [96, 32], [127, 0], [32, 0], [0, 0]];
  const padCount = IRIG_MIDI.padGreenLedCCs.length;
  const interval = 10000 / (padCount * colors.length);
  let frame = 0;
  let activePad: number | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const sendMessages = (messages: number[][]) => { for (const bytes of messages) send(bytes); };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    const messages: number[][] = activePad === null ? [] : padLedMessages(activePad, [0, 0]);
    for (let index = 0; index < IRIG_MIDI.buttonGreenLedCCs.length; index++) {
      messages.push(...buttonLedMessages(index, [0, 0]));
    }
    const errors: string[] = [];
    for (const bytes of messages) {
      try {
        send(bytes);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (errors.length) throw new Error(`Could not clear LEDs: ${errors.join('; ')}`);
  };
  const fail = (error: unknown) => {
    let message = `Could not send LED test: ${error instanceof Error ? error.message : String(error)}`;
    try {
      stop();
    } catch (cleanupError) {
      message += `; could not clear LEDs: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`;
    }
    onError(message);
  };
  const tick = () => {
    try {
      if (frame === padCount * colors.length) {
        stop();
        onComplete();
        return;
      }
      if (frame === 0) {
        for (let pad = 0; pad < padCount; pad++) sendMessages(padLedMessages(pad, [0, 0]));
      }
      activePad = Math.floor(frame / colors.length);
      const color = colors[frame % colors.length];
      sendMessages(padLedMessages(activePad, color));
      for (let index = 0; index < IRIG_MIDI.buttonGreenLedCCs.length; index++) {
        sendMessages(buttonLedMessages(index, color));
      }
      frame++;
      timer = setTimeout(tick, interval);
    } catch (error) {
      fail(error);
    }
  };
  tick();
  return stop;
}
