import React, { useId, useRef, useState } from 'react';
import { CacheSummary, UnifiedCache } from '../../shared/cache/types';
import { BrowserCacheSummaryMeta, saveBrowserCacheFiles } from '../ClientCacheProxy';

interface CacheLoaderPanelProps {
  summary: CacheSummary | null;
  activePath: string;
  candidateDirs: string[];
  isBusy: boolean;
  statusMessage: string;
  isUsingBrowserCache: boolean;
  savedCacheMeta: BrowserCacheSummaryMeta | null;
  adminToken: string;
  onLoadServerPath: (dirPath: string) => Promise<void>;
  onDownloadOpenRs2: () => Promise<void>;
  onLoadBrowserCache: (cache: UnifiedCache, summary: CacheSummary) => void;
  onUseServerCache: () => Promise<void>;
  onClearSavedCache: () => Promise<void>;
  onChangeAdminToken: (token: string) => void;
}

export const CacheLoaderPanel: React.FC<CacheLoaderPanelProps> = ({
  summary,
  activePath,
  candidateDirs,
  isBusy,
  statusMessage,
  isUsingBrowserCache,
  savedCacheMeta,
  adminToken,
  onLoadServerPath,
  onDownloadOpenRs2,
  onLoadBrowserCache,
  onUseServerCache,
  onClearSavedCache,
  onChangeAdminToken,
}) => {
  const headingId = useId();
  const fileInputId = useId();
  const rawInputId = useId();
  const adminTokenId = useId();

  const [localError, setLocalError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const folderInputRef = useRef<HTMLInputElement>(null);
  const filesInputRef = useRef<HTMLInputElement>(null);

  const handleFilesSelected = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setLocalError(null);
    try {
      const cache = await saveBrowserCacheFiles(files, `Browser Local Cache (${files.length} files)`);
      const nextSummary = await cache.getSummary();
      onLoadBrowserCache(cache, nextSummary);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <section className="card" aria-labelledby={headingId}>
      <h2 id={headingId}>Game Cache Source</h2>

      <div className="field">
        <span className="field-label">
          Active Source:{' '}
          <strong>{isUsingBrowserCache ? 'Browser Local Cache' : `Server Cache (${activePath})`}</strong>
        </span>
        <div className="btn-row">
          {isUsingBrowserCache && (
            <button
              type="button"
              className="primary compact"
              disabled={isBusy}
              onClick={() => void onUseServerCache()}
            >
              Use Server Default Cache
            </button>
          )}
          {candidateDirs.map((dir) => (
            <button
              key={dir}
              type="button"
              className="compact"
              disabled={isBusy}
              onClick={() => void onLoadServerPath(dir)}
            >
              {dir === './cache' ? './cache (Server Default)' : dir}
            </button>
          ))}
        </div>
        <span className="hint">
          Supports <code>.dat2/.idx*</code>, Abex <code>.flatcache</code>, OpenRS2 flat-file dirs, legacy 317 <code>.dat/.idx</code>, or plain <code>.dat</code> model files.
        </span>
      </div>

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
          Load a custom cache locally in your browser (stored in <code>localStorage</code> / <code>IndexedDB</code>, never uploaded to server):
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
        </div>

        {savedCacheMeta && (
          <div className="btn-row" style={{ justifyContent: 'center', marginTop: '0.6rem' }}>
            <span className="hint">
              Saved browser cache: <strong>{savedCacheMeta.label}</strong> ({savedCacheMeta.fileCount} files)
            </span>
            <button
              type="button"
              className="compact"
              disabled={isBusy}
              onClick={() => void onClearSavedCache()}
            >
              Clear Saved Browser Cache
            </button>
          </div>
        )}

        {localError && (
          <div className="error-text" role="alert" style={{ marginTop: '0.5rem' }}>
            {localError}
          </div>
        )}
      </div>

      <details style={{ marginTop: '0.75rem' }}>
        <summary className="hint" style={{ cursor: 'pointer', fontWeight: 600 }}>
          Server Admin (Self-Hosted)
        </summary>
        <div style={{ marginTop: '0.6rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor={adminTokenId}>Admin Token (stored in localStorage)</label>
            <input
              id={adminTokenId}
              type="password"
              value={adminToken}
              autoComplete="off"
              spellCheck={false}
              placeholder="Required remotely when OSRS_ADMIN_TOKEN is set"
              onChange={(e) => onChangeAdminToken(e.target.value)}
            />
          </div>
          <div className="btn-row">
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
      </details>

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
