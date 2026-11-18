import React, { useId, useRef, useState } from 'react';
import { CacheSummary, UnifiedCache } from '../../shared/cache/types';
import { openBrowserCacheFromFiles } from '../ClientCacheProxy';

interface CacheLoaderPanelProps {
  summary: CacheSummary | null;
  activePath: string;
  candidateDirs: string[];
  isBusy: boolean;
  statusMessage: string;
  onLoadServerPath: (dirPath: string) => Promise<void>;
  onDownloadOpenRs2: () => Promise<void>;
  onLoadBrowserCache: (cache: UnifiedCache, summary: CacheSummary) => void;
}

export const CacheLoaderPanel: React.FC<CacheLoaderPanelProps> = ({
  summary,
  activePath,
  candidateDirs,
  isBusy,
  statusMessage,
  onLoadServerPath,
  onDownloadOpenRs2,
  onLoadBrowserCache,
}) => {
  const headingId = useId();
  const pathInputId = useId();
  const pathHelpId = useId();
  const fileInputId = useId();
  const rawInputId = useId();

  const [dirInput, setDirInput] = useState(activePath || './cache');
  const [localError, setLocalError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const folderInputRef = useRef<HTMLInputElement>(null);
  const filesInputRef = useRef<HTMLInputElement>(null);

  const handleSubmitPath = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    const trimmed = dirInput.trim();
    if (!trimmed) {
      setLocalError('Enter a cache directory path on the server.');
      return;
    }
    await onLoadServerPath(trimmed);
  };

  const handleFilesSelected = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setLocalError(null);
    try {
      const cache = await openBrowserCacheFromFiles(files, `Browser Upload (${files.length} files)`);
      const nextSummary = await cache.getSummary();
      onLoadBrowserCache(cache, nextSummary);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <section className="card" aria-labelledby={headingId}>
      <h2 id={headingId}>Game Cache Source</h2>

      <form
        aria-labelledby={headingId}
        onSubmit={handleSubmitPath}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && e.nativeEvent.isComposing) e.preventDefault();
        }}
      >
        <div className="field">
          <label htmlFor={pathInputId}>Local Cache Directory (Server)</label>
          <div className="input-row">
            <input
              id={pathInputId}
              name="cacheDirPath"
              type="text"
              value={dirInput}
              onChange={(e) => {
                setDirInput(e.target.value);
                setLocalError(null);
              }}
              aria-invalid={localError ? 'true' : undefined}
              aria-describedby={localError ? `${pathHelpId} cache-path-err` : pathHelpId}
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              enterKeyHint="go"
            />
            <button type="submit" className="primary compact" disabled={isBusy}>
              Load Path
            </button>
          </div>
          <span id={pathHelpId} className="hint">
            Supports <code>.dat2/.idx*</code>, Abex <code>.flatcache</code>, OpenRS2 flat-file dirs, legacy 317 <code>.dat/.idx</code>, or plain <code>.dat</code> model files.
          </span>
          {localError && (
            <span id="cache-path-err" className="error-text" role="alert">
              {localError}
            </span>
          )}
        </div>
      </form>

      {candidateDirs.length > 0 && (
        <div className="field">
          <span className="field-label">Detected Directories</span>
          <div className="btn-row">
            {candidateDirs.map((dir) => (
              <button
                key={dir}
                type="button"
                className="compact"
                disabled={isBusy}
                onClick={() => {
                  setDirInput(dir);
                  void onLoadServerPath(dir);
                }}
              >
                {dir.endsWith('/cache') ? './cache (Starter)' : dir}
              </button>
            ))}
          </div>
        </div>
      )}

      <div
        className={`file-drop-zone ${isDragging ? 'dragover' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setIsDragging(false);
          void handleFilesSelected(e.dataTransfer.files);
        }}
      >
        <p className="hint" style={{ marginTop: 0 }}>
          Or load a cache directly in your browser (no upload to server):
        </p>
        <div className="btn-row" style={{ justifyContent: 'center' }}>
          <input
            ref={folderInputRef}
            id={fileInputId}
            type="file"
            className="visually-hidden"
            multiple
            {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
            onChange={(e) => void handleFilesSelected(e.target.files)}
          />
          <button
            type="button"
            className="compact"
            disabled={isBusy}
            onClick={() => folderInputRef.current?.click()}
          >
            Pick Cache Folder
          </button>

          <input
            ref={filesInputRef}
            id={rawInputId}
            type="file"
            className="visually-hidden"
            multiple
            onChange={(e) => void handleFilesSelected(e.target.files)}
          />
          <button
            type="button"
            className="compact"
            disabled={isBusy}
            onClick={() => filesInputRef.current?.click()}
          >
            Pick .dat / .idx / .flatcache Files
          </button>

          <button
            type="button"
            className="compact"
            disabled={isBusy}
            onClick={() => void onDownloadOpenRs2()}
          >
            Fetch Latest OpenRS2 Cache
          </button>
        </div>
      </div>

      <div role="status" aria-live="polite" className="hint" style={{ marginTop: '0.75rem' }}>
        {statusMessage}
        {summary && (
          <div>
            Format: <strong>{summary.format}</strong> · NPCs: <strong>{summary.npcCount}</strong> (
            {summary.chatheadNpcCount} with chatheads) · Headgear items:{' '}
            <strong>{summary.headgearItemCount}</strong> · Kits: <strong>{summary.kitCount}</strong> · Seqs:{' '}
            <strong>{summary.seqCount}</strong>
          </div>
        )}
      </div>
    </section>
  );
};
