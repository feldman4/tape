import { btnStyle } from '../btnStyle';

interface ProjTabProps {
  sessionName: string;
  setSessionName: (name: string) => void;
  sessionStatus: string;
  sessions: string[];
  handleSave: () => void;
  handleLoad: (name: string) => void;
  handleNew: () => void;
  handleDeleteSession: (name: string) => void;
}

export function ProjTab({
  sessionName, setSessionName, sessionStatus, sessions,
  handleSave, handleLoad, handleNew, handleDeleteSession,
}: ProjTabProps) {
  return (
    <>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
        <input
          type="text"
          placeholder="Session name"
          value={sessionName}
          onChange={(e) => setSessionName(e.target.value)}
          style={{ padding: '3px 8px', background: '#27272a', border: '1px solid #3f3f46', color: '#e4e4e7', borderRadius: 4, width: 180 }}
        />
        <button style={btnStyle} onClick={() => void handleSave()} disabled={!sessionName.trim()}>Save</button>
        <button style={btnStyle} onClick={handleNew}>New</button>
        {sessions.length > 0 && (
          <select
            style={{ padding: '3px 8px', background: '#27272a', border: '1px solid #3f3f46', color: '#e4e4e7', borderRadius: 4 }}
            defaultValue=""
            onChange={(e) => { if (e.target.value) void handleLoad(e.target.value); }}
          >
            <option value="" disabled>Load session…</option>
            {sessions.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        )}
        {sessionName && sessions.includes(sessionName) && (
          <button style={{ ...btnStyle, color: '#f87171' }} onClick={() => void handleDeleteSession(sessionName)}>Delete</button>
        )}
      </div>
      {sessionStatus && <div style={{ fontSize: 12, color: '#a1a1aa' }}>{sessionStatus}</div>}
    </>
  );
}
