export interface PlatformCapabilities {
  webMidi: boolean;
  audioOutputSelection: boolean;
  pointerEvents: boolean;
  touch: boolean;
}

export function detectPlatformCapabilities(): PlatformCapabilities {
  const navigatorWithMidi = navigator as Navigator & {
    requestMIDIAccess?: () => Promise<MIDIAccess>;
  };
  const audioContextPrototype = AudioContext.prototype as AudioContext & {
    setSinkId?: (sinkId: string) => Promise<void>;
  };

  return {
    webMidi: typeof navigatorWithMidi.requestMIDIAccess === 'function',
    audioOutputSelection: typeof audioContextPrototype.setSinkId === 'function',
    pointerEvents: typeof window.PointerEvent === 'function',
    touch: navigator.maxTouchPoints > 0,
  };
}