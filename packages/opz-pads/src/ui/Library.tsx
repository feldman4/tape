import { useEffect, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import type { Engine } from '../engine/engine.ts';
import { newProject, newScene } from '../project/model.ts';
import { filename, loadLibrary, nameFromFile, parseKitFile, parseProjectFile, saveLibrary } from '../project/storage.ts';
import type { Library } from '../project/storage.ts';

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
export const kitDragType = 'application/x-opz-pads-kit';

export function LibraryView({ engine, reportError }: { engine: Engine; reportError: (message: string) => void }) {
  const [library, setLibrary] = useState<Library | null>(null);
  const libraryRef = useRef<Library | null>(null);
  const activeRef = useRef(false);
  const [projectName, setProjectName] = useState('');
  const [kitName, setKitName] = useState('');
  const current = engine.project.scenes[engine.scene];
  const canLoadKit = engine.scene !== 0;

  useEffect(() => {
    activeRef.current = true;
    try {
      const data = loadLibrary();
      libraryRef.current = data;
      setLibrary(data);
    } catch (error) {
      reportError(`Could not load library: ${errorText(error)}`);
    }
    return () => { activeRef.current = false; };
  }, [reportError]);

  function persist(next: Library): void {
    try {
      saveLibrary(next);
      libraryRef.current = next;
      setLibrary(next);
      reportError('');
    } catch (error) {
      reportError(`Could not save library: ${errorText(error)}`);
    }
  }

  function download(value: unknown, name: string): void {
    try {
      const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      reportError(`Could not download file: ${errorText(error)}`);
    }
  }

  function saveProject(): void {
    if (!library) return;
    const name = projectName.trim();
    if (!name) { reportError('Enter a project name.'); return; }
    persist({ ...library, projects: [...library.projects.filter((item) => item.name !== name),
      { name, value: structuredClone(engine.project) }] });
  }

  function saveKit(): void {
    if (!library || current.type !== 'drum') return;
    const name = kitName.trim();
    if (!name) { reportError('Enter a kit name.'); return; }
    persist({ ...library, kits: [...library.kits.filter((item) => item.name !== name),
      { name, value: structuredClone(current) }] });
  }

  async function importFiles(files: File[], type: 'project' | 'kit'): Promise<void> {
    try {
      if (!files.length) throw new Error('Drop at least one file.');
      const entries = await Promise.all(files.map(async (file) => {
        try {
          const name = nameFromFile(type, file.name);
          const data: unknown = JSON.parse(await file.text());
          if (type === 'project') {
            return { type: 'project' as const, name, value: parseProjectFile(data) };
          }
          return { type: 'kit' as const, name, value: parseKitFile(data) };
        } catch (error) {
          throw new Error(`${file.name}: ${errorText(error)}`);
        }
      }));
      if (!activeRef.current) throw new Error('Import cancelled because the Project view closed.');
      let next = libraryRef.current;
      if (!next) throw new Error('The library is unavailable.');
      let changed = false;
      for (const entry of entries) {
        if (entry.type === 'project') {
          if (next.projects.some((item) => item.name === entry.name) &&
            !confirm(`Replace project "${entry.name}" in the library?`)) continue;
          next = { ...next, projects: [...next.projects.filter((item) => item.name !== entry.name),
            { name: entry.name, value: entry.value }] };
        } else {
          if (next.kits.some((item) => item.name === entry.name) &&
            !confirm(`Replace kit "${entry.name}" in the library?`)) continue;
          next = { ...next, kits: [...next.kits.filter((item) => item.name !== entry.name),
            { name: entry.name, value: entry.value }] };
        }
        changed = true;
      }
      if (changed) persist(next);
    } catch (error) {
      reportError(`Could not import files: ${errorText(error)}`);
    }
  }

  function dropFiles(event: DragEvent<HTMLElement>, type: 'project' | 'kit'): void {
    if (!Array.from(event.dataTransfer.types).includes('Files')) return;
    event.preventDefault();
    void importFiles(Array.from(event.dataTransfer.files), type);
  }

  return <aside className="project">
      <section aria-label="Project library" onDragOver={(event) => {
        if (Array.from(event.dataTransfer.types).includes('Files')) event.preventDefault();
      }} onDrop={(event) => dropFiles(event, 'project')}><h2>PROJECTS</h2>
        <input aria-label="Project name" value={projectName} onChange={(event) => setProjectName(event.currentTarget.value)} />
        <div className="library-actions"><button aria-label="Save project" disabled={!library} onClick={saveProject}>Save</button>
          <button aria-label="Init project" onClick={() => { if (confirm('Replace the current project?')) engine.setProject(newProject()); }}>Init</button></div>
        <ul className="library-list">{library?.projects.map((item) => <li key={item.name}>
          <button onClick={() => { if (confirm('Replace the current project?')) engine.setProject(structuredClone(item.value)); }}>{item.name}</button>
          <button aria-label={`Download project ${item.name}`} title="Download" onClick={() =>
            download(item.value, filename('project', item.name))}><DownloadIcon /></button>
          <button aria-label={`Delete project ${item.name}`} onClick={() => {
            if (confirm(`Delete project "${item.name}" from the library?`)) {
              persist({ ...library, projects: library.projects.filter((entry) => entry.name !== item.name) });
            }
          }}>×</button></li>)}</ul>
      </section>
      <section aria-label="Kit library" onDragOver={(event) => {
        if (Array.from(event.dataTransfer.types).includes('Files')) event.preventDefault();
      }} onDrop={(event) => dropFiles(event, 'kit')}><h2>KITS</h2>
        <input aria-label="Kit name" value={kitName} onChange={(event) => setKitName(event.currentTarget.value)} />
        <div className="library-actions"><button aria-label="Save kit" disabled={!library || current.type !== 'drum'} onClick={saveKit}>Save</button>
          <button aria-label="Init kit" disabled={!canLoadKit} onClick={() => {
            if (confirm('Initialize the current scene as an empty drum kit?')) engine.setKit(engine.scene, newScene('drum'));
          }}>Init</button></div>
        <ul className="library-list">{library?.kits.map((item) => <li key={item.name}>
          <span className="kit-drag" draggable onDragStart={(event) => {
            event.dataTransfer.effectAllowed = 'copy';
            event.dataTransfer.setData(kitDragType, JSON.stringify(item.value));
          }}><button disabled={!canLoadKit} onClick={() => {
            if (confirm('Replace the current scene with this kit?')) engine.setKit(engine.scene, item.value);
          }}>{item.name}</button></span>
          <button aria-label={`Download kit ${item.name}`} title="Download" onClick={() =>
            download({ version: 2, kit: item.value }, filename('kit', item.name))}><DownloadIcon /></button>
          <button aria-label={`Delete kit ${item.name}`} onClick={() => {
            if (confirm(`Delete kit "${item.name}" from the library?`)) {
              persist({ ...library, kits: library.kits.filter((entry) => entry.name !== item.name) });
            }
          }}>×</button></li>)}</ul>
      </section>
  </aside>;
}

function DownloadIcon() {
  return <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none">
    <path d="M8 1v9m-4-4 4 4 4-4M2 12v2h12v-2" stroke="currentColor" />
  </svg>;
}
