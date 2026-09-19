import { useEffect } from 'react';
import type { MutableRefObject } from 'react';
import type { AudioEngine } from '../../audio/audioEngine';
import type { AudioPool } from '../../audio/audioPool';
import type { Tape } from '../../tape/model';
import type { TransportState } from '../tapeRefs';
import { CANVAS_HEIGHT, CANVAS_WIDTH } from '../canvasConstants';
import { drawTimeline, type TimelineLayout } from '../renderers/TimelineRenderer';

interface TimelineRenderRefs {
  canvasRef: MutableRefObject<HTMLCanvasElement | null>;
  engineRef: MutableRefObject<AudioEngine | null>;
  poolRef: MutableRefObject<AudioPool>;
  tapeRef: MutableRefObject<Tape>;
  transportRef: MutableRefObject<TransportState>;
  snapRef: MutableRefObject<boolean>;
  tapeStartForRecordingRef: MutableRefObject<number>;
  recordStartWallTimeRef: MutableRefObject<number>;
  viewWidthSamplesRef: MutableRefObject<number>;
}

function recordingDisplayPlayhead(tape: Tape, tapeStart: number, elapsedSamples: number): number {
  const linearPosition = tapeStart + elapsedSamples;
  const { loopEnabled, loopIn, loopOut } = tape;
  return loopEnabled && loopOut > loopIn && linearPosition >= loopIn
    ? loopIn + (linearPosition - loopIn) % (loopOut - loopIn)
    : linearPosition;
}

export function useTimelineRender({
  canvasRef,
  engineRef,
  poolRef,
  tapeRef,
  transportRef,
  snapRef,
  tapeStartForRecordingRef,
  recordStartWallTimeRef,
  viewWidthSamplesRef,
}: TimelineRenderRefs): void {
  useEffect(() => {
    let frameId = 0;
    const render = () => {
      const canvas = canvasRef.current;
      const context = canvas?.getContext('2d');
      if (canvas && context) {
        const tape = tapeRef.current;
        const sampleRate = engineRef.current?.sampleRate ?? 44100;
        const playhead = transportRef.current === 'recording'
          ? recordingDisplayPlayhead(
              tape,
              tapeStartForRecordingRef.current,
              Math.round((Date.now() - recordStartWallTimeRef.current) / 1000 * sampleRate),
            )
          : tape.playhead;
        const displayTape = playhead === tape.playhead ? tape : { ...tape, playhead };
        const layout: TimelineLayout = {
          canvasWidth: CANVAS_WIDTH,
          canvasHeight: CANVAS_HEIGHT,
          playhead,
          viewWidthSamples: viewWidthSamplesRef.current,
        };
        drawTimeline(context, displayTape, poolRef.current, layout, snapRef.current);
      }
      frameId = requestAnimationFrame(render);
    };
    frameId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(frameId);
  }, [canvasRef, engineRef, poolRef, recordStartWallTimeRef, snapRef, tapeRef, tapeStartForRecordingRef, transportRef, viewWidthSamplesRef]);
}