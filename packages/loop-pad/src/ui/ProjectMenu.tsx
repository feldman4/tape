import { useEffect, useRef, useState } from 'react';

interface ProjectMenuProps {
  projectIndex: number;
  projectCount: number;
  onSelect: (index: number) => Promise<void>;
  onInitialize: () => Promise<void>;
  onDownload: () => Promise<void>;
  onRestore: (file: File) => Promise<void>;
}

export function ProjectMenu({ projectIndex, projectCount, onSelect, onInitialize, onDownload, onRestore }: ProjectMenuProps) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const selectRef = useRef<HTMLSelectElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const closeMenu = () => {
    setOpen(false);
    buttonRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    selectRef.current?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeMenu();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div ref={menuRef} className="project-menu">
      <button
        ref={buttonRef}
        className="toolbar-button project-button"
        aria-expanded={open}
        aria-controls="project-options"
        onClick={() => setOpen((value) => !value)}
      >
        Project {String(projectIndex).padStart(2, '0')}
        <span className="project-chevron" aria-hidden="true" />
      </button>
      {open && (
        <div id="project-options" className="project-pane" role="dialog" aria-label="Project options">
          <label htmlFor="project-choice">Project</label>
          <select
            ref={selectRef}
            id="project-choice"
            value={projectIndex}
            onChange={(event) => {
              const index = Number(event.target.value);
              closeMenu();
              void onSelect(index);
            }}
          >
            {Array.from({ length: projectCount }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>Project {String(n).padStart(2, '0')}</option>
            ))}
          </select>
          <div className="project-actions">
            <button onClick={() => {
              if (window.confirm(`Initialize Project ${projectIndex}? This cannot be undone.`)) {
                closeMenu();
                void onInitialize();
              }
            }}>Initialize</button>
            <button onClick={() => {
              setOpen(false);
              buttonRef.current?.focus();
              void onDownload();
            }}>Download</button>
            <button onClick={() => {
              setOpen(false);
              fileInputRef.current?.click();
            }}>Restore</button>
          </div>
        </div>
      )}
      <input
        ref={fileInputRef}
        type="file"
        style={{ display: 'none' }}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void onRestore(file);
          event.target.value = '';
        }}
      />
    </div>
  );
}
