import type { Tape } from '../../tape/model';
import { btnStyle } from '../btnStyle';

interface MixerTabProps {
  tape: Tape;
  handleLaneGain: (laneIndex: 0 | 1 | 2 | 3, gain: number) => void;
  handleLanePan: (laneIndex: 0 | 1 | 2 | 3, pan: number) => void;
  handleLaneMute: (laneIndex: 0 | 1 | 2 | 3) => void;
}

export function MixerTab({ tape, handleLaneGain, handleLanePan, handleLaneMute }: MixerTabProps) {
  return (
    <div style={{ display: 'flex', gap: 16 }}>
      {([0, 1, 2, 3] as const).map((li) => {
        const lane = tape.lanes[li];
        const panPct = Math.round(lane.pan * 100);
        const panLabel = panPct === 0 ? 'C' : panPct < 0 ? `L${Math.abs(panPct)}` : `R${panPct}`;
        const gainPct = Math.round(lane.gain * 100);
        return (
          <div key={li} style={{
            background: '#18181b', borderRadius: 6, padding: '12px 14px',
            display: 'flex', flexDirection: 'column', alignItems: 'center',
            gap: 10, minWidth: 54,
            opacity: lane.muted ? 0.5 : 1,
          }}>
            {/* Gain fader */}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, width: '100%' }}>
              <span style={{ fontSize: 11, color: '#52525b' }}>Vol</span>
              <div style={{ position: 'relative', height: 80, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <input
                  type="range" min={0} max={2} step={0.01} value={lane.gain}
                  onChange={(e) => handleLaneGain(li, Number(e.target.value))}
                  style={{ width: 76, transform: 'rotate(-90deg)', transformOrigin: 'center center', position: 'absolute' }}
                />
              </div>
              <span style={{ fontSize: 11, color: '#71717a' }}>{gainPct}%</span>
            </div>

            {/* Pan */}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, width: '100%' }}>
              <span style={{ fontSize: 11, color: '#52525b' }}>Pan</span>
              <input
                type="range" min={-0.6} max={0.6} step={0.01} value={lane.pan}
                onChange={(e) => handleLanePan(li, Number(e.target.value))}
                style={{ width: '100%' }}
              />
              <span style={{ fontSize: 11, color: '#71717a' }}>{panLabel}</span>
            </div>

            {/* Mute */}
            <button
              onClick={() => handleLaneMute(li)}
              style={{ ...btnStyle, fontSize: 11, width: '100%',
                ...(lane.muted ? { background: '#92400e', color: '#fcd34d', borderColor: '#b45309' } : {}),
              }}>
              {lane.muted ? 'Muted' : 'Mute'}
            </button>
          </div>
        );
      })}
    </div>
  );
}
