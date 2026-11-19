import React, { useEffect, useId, useRef, useState } from 'react';
import { ChatboxLayout, renderChatbox, stackChatboxes } from '../../shared/renderer/ChatboxRenderer';
import { encodeAnimatedGif } from '../../shared/renderer/GifExporter';
import { RasterOutput } from '../../shared/renderer/SoftwareRasterizer';

export interface DialogueTurn {
  id: string;
  speakerName: string;
  dialogueText: string;
  promptText: string;
  showPrompt: boolean;
  layout: ChatboxLayout;
  snapshot: RasterOutput | null;
}

interface ChatboxComposerProps {
  regularHead: RasterOutput | null;
  fullHead: RasterOutput | null;
  hasSubstantialDifference: boolean;
  defaultSpeakerName: string;
  defaultLayout: ChatboxLayout;
  hasSequence: boolean;
  isPlaying: boolean;
  renderScale: number;
  onRenderSequenceFrames: (
    scale: number,
    fullUncropped?: boolean
  ) => Promise<Array<{ frame: RasterOutput; delayMs: number }>>;
}

function rasterToDataUrl(raster: RasterOutput): string {
  const canvas = document.createElement('canvas');
  canvas.width = raster.width;
  canvas.height = raster.height;
  const ctx = canvas.getContext('2d')!;
  const img = new ImageData(new Uint8ClampedArray(raster.pixels), raster.width, raster.height);
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL('image/png');
}

function rasterToPngBlob(raster: RasterOutput): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const canvas = document.createElement('canvas');
    canvas.width = raster.width;
    canvas.height = raster.height;
    const ctx = canvas.getContext('2d')!;
    const img = new ImageData(new Uint8ClampedArray(raster.pixels), raster.width, raster.height);
    ctx.putImageData(img, 0, 0);
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Failed to encode PNG blob.'));
    }, 'image/png');
  });
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadPngFromRaster(raster: RasterOutput, filename: string): void {
  const canvas = document.createElement('canvas');
  canvas.width = raster.width;
  canvas.height = raster.height;
  const ctx = canvas.getContext('2d')!;
  const img = new ImageData(new Uint8ClampedArray(raster.pixels), raster.width, raster.height);
  ctx.putImageData(img, 0, 0);
  canvas.toBlob((blob) => {
    if (blob) downloadBlob(blob, filename);
  }, 'image/png');
}

export const ChatboxComposer: React.FC<ChatboxComposerProps> = ({
  regularHead,
  fullHead,
  hasSubstantialDifference,
  defaultSpeakerName,
  defaultLayout,
  hasSequence,
  isPlaying,
  renderScale,
  onRenderSequenceFrames,
}) => {
  const formHeadingId = useId();
  const speakerId = useId();
  const dialogueId = useId();
  const promptCheckId = useId();
  const promptInputId = useId();
  const layoutLeftId = useId();
  const layoutRightId = useId();
  const layoutNoneId = useId();
  const fullToggleId = useId();

  const [speakerName, setSpeakerName] = useState(defaultSpeakerName);
  const [dialogueText, setDialogueText] = useState(
    'Hello adventurer! Use <col=800000>OSRS tags</col> or pick any NPC or Player chathead.'
  );
  const [showPrompt, setShowPrompt] = useState(true);
  const [promptText, setPromptText] = useState('Click here to continue');
  const [layout, setLayout] = useState<ChatboxLayout>(defaultLayout);
  const [alwaysShowFullPreview, setAlwaysShowFullPreview] = useState(false);
  const [turns, setTurns] = useState<DialogueTurn[]>([]);
  const [isExporting, setIsExporting] = useState(false);
  const [exportStatus, setExportStatus] = useState('');

  const [regularPreviewUrl, setRegularPreviewUrl] = useState<string | null>(null);
  const [fullPreviewUrl, setFullPreviewUrl] = useState<string | null>(null);
  const [fullGifDims, setFullGifDims] = useState<{ width: number; height: number } | null>(null);
  const [chatboxPreviewUrl, setChatboxPreviewUrl] = useState<string | null>(null);
  const [regularSeqFrames, setRegularSeqFrames] = useState<Array<{
    frame: RasterOutput;
    delayMs: number;
  }> | null>(null);

  const regularGifBlobRef = useRef<Blob | null>(null);
  const fullGifBlobRef = useRef<Blob | null>(null);
  const chatboxGifBlobRef = useRef<Blob | null>(null);

  const hasRegularHead = Boolean(regularHead);
  const latestHeadsRef = useRef({ regularHead, fullHead });
  latestHeadsRef.current = { regularHead, fullHead };
  const staticRegularHead = !isPlaying || !hasSequence ? regularHead : null;
  const staticFullHead = !isPlaying || !hasSequence ? fullHead : null;

  const showFullCard = Boolean(fullHead && (hasSubstantialDifference || alwaysShowFullPreview));

  // Sync speaker name & layout when switching subject unless user typed custom name
  useEffect(() => {
    setSpeakerName(defaultSpeakerName);
  }, [defaultSpeakerName]);

  useEffect(() => {
    setLayout(defaultLayout);
  }, [defaultLayout]);

  // Revoke object URLs cleanly only after replacement commits
  useEffect(() => {
    return () => {
      if (regularPreviewUrl) URL.revokeObjectURL(regularPreviewUrl);
    };
  }, [regularPreviewUrl]);

  useEffect(() => {
    return () => {
      if (fullPreviewUrl) URL.revokeObjectURL(fullPreviewUrl);
    };
  }, [fullPreviewUrl]);

  useEffect(() => {
    return () => {
      if (chatboxPreviewUrl) URL.revokeObjectURL(chatboxPreviewUrl);
    };
  }, [chatboxPreviewUrl]);

  // Build stable client-side Blob URLs (image/gif when playing, image/png when paused/static)
  useEffect(() => {
    let cancelled = false;
    regularGifBlobRef.current = null;
    fullGifBlobRef.current = null;

    if (!hasRegularHead) {
      setRegularPreviewUrl(null);
      setFullPreviewUrl(null);
      setFullGifDims(null);
      setRegularSeqFrames(null);
      return;
    }

    const commitBlob = (
      blob: Blob,
      setter: React.Dispatch<React.SetStateAction<string | null>>
    ) => {
      const url = URL.createObjectURL(blob);
      if (cancelled) {
        URL.revokeObjectURL(url);
        return;
      }
      setter(url);
    };

    const buildHeadPreviews = async () => {
      if (isPlaying && hasSequence) {
        setRegularSeqFrames(null);
        const regFrames = await onRenderSequenceFrames(renderScale, false);
        if (cancelled) return;

        setRegularSeqFrames(regFrames);
        if (regFrames.length > 0) {
          const regGifBytes = encodeAnimatedGif(regFrames, true);
          const regBlob = new Blob([new Uint8Array(regGifBytes)], { type: 'image/gif' });
          regularGifBlobRef.current = regBlob;
          commitBlob(regBlob, setRegularPreviewUrl);
          if (cancelled) return;
        } else if (latestHeadsRef.current.regularHead) {
          const regBlob = await rasterToPngBlob(latestHeadsRef.current.regularHead);
          if (cancelled) return;
          commitBlob(regBlob, setRegularPreviewUrl);
          if (cancelled) return;
        }

        if (showFullCard) {
          const fullFrames = await onRenderSequenceFrames(renderScale, true);
          if (cancelled) return;
          if (fullFrames.length > 0) {
            setFullGifDims({
              width: fullFrames[0].frame.width,
              height: fullFrames[0].frame.height,
            });
            const fullGifBytes = encodeAnimatedGif(fullFrames, true);
            const fullBlob = new Blob([new Uint8Array(fullGifBytes)], { type: 'image/gif' });
            fullGifBlobRef.current = fullBlob;
            commitBlob(fullBlob, setFullPreviewUrl);
          } else if (latestHeadsRef.current.fullHead) {
            setFullGifDims(null);
            const fullBlob = await rasterToPngBlob(latestHeadsRef.current.fullHead);
            if (cancelled) return;
            commitBlob(fullBlob, setFullPreviewUrl);
          }
        } else {
          setFullGifDims(null);
          setFullPreviewUrl(null);
        }
        return;
      }

      setRegularSeqFrames(null);
      setFullGifDims(null);

      if (!staticRegularHead) return;
      const regBlob = await rasterToPngBlob(staticRegularHead);
      if (cancelled) return;
      commitBlob(regBlob, setRegularPreviewUrl);
      if (cancelled) return;

      if (showFullCard && staticFullHead) {
        const fullBlob = await rasterToPngBlob(staticFullHead);
        if (cancelled) return;
        commitBlob(fullBlob, setFullPreviewUrl);
      } else {
        setFullPreviewUrl(null);
      }
    };

    void buildHeadPreviews();
    return () => {
      cancelled = true;
    };
  }, [
    hasRegularHead,
    staticRegularHead,
    staticFullHead,
    showFullCard,
    isPlaying,
    hasSequence,
    renderScale,
    onRenderSequenceFrames,
  ]);

  // Build stable 519x142 OSRS chatbox <img> preview (animated GIF while playing, PNG while paused/static)
  useEffect(() => {
    let cancelled = false;
    chatboxGifBlobRef.current = null;

    if (isPlaying && hasSequence && hasRegularHead && regularSeqFrames === null) {
      return;
    }

    const timer = setTimeout(
      () => {
        const buildChatboxPreview = async () => {
          if (isPlaying && hasSequence && regularSeqFrames && regularSeqFrames.length > 0) {
            const boxPoseCache = new Map<RasterOutput, RasterOutput>();
            const boxFrames = regularSeqFrames.map((f) => {
              let cachedBox = boxPoseCache.get(f.frame);
              if (!cachedBox) {
                cachedBox = renderChatbox(f.frame, {
                  speakerName,
                  dialogueText,
                  promptText,
                  showPrompt,
                  layout,
                  scale: 1,
                });
                boxPoseCache.set(f.frame, cachedBox);
              }
              return { frame: cachedBox, delayMs: f.delayMs };
            });

            const gifBytes = encodeAnimatedGif(boxFrames, false);
            const blob = new Blob([new Uint8Array(gifBytes)], { type: 'image/gif' });
            chatboxGifBlobRef.current = blob;
            const url = URL.createObjectURL(blob);
            if (cancelled) {
              URL.revokeObjectURL(url);
              return;
            }
            setChatboxPreviewUrl(url);
            return;
          }

          const box = renderChatbox(latestHeadsRef.current.regularHead, {
            speakerName,
            dialogueText,
            promptText,
            showPrompt,
            layout,
            scale: 1,
          });
          const blob = await rasterToPngBlob(box);
          if (cancelled) return;
          const url = URL.createObjectURL(blob);
          if (cancelled) {
            URL.revokeObjectURL(url);
            return;
          }
          setChatboxPreviewUrl(url);
        };

        void buildChatboxPreview();
      },
      regularSeqFrames && regularSeqFrames.length > 0 ? 60 : 120
    );

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    isPlaying,
    hasSequence,
    hasRegularHead,
    staticRegularHead,
    regularSeqFrames,
    speakerName,
    dialogueText,
    promptText,
    showPrompt,
    layout,
  ]);

  const handleExportChatheadPng = (variant: 'regular' | 'full') => {
    const target = variant === 'full' ? fullHead : regularHead;
    if (!target) return;
    const slug = (speakerName || 'chathead').toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const filename = `${slug}-chathead-${variant}.png`;
    downloadPngFromRaster(target, filename);
    setExportStatus(`Exported ${filename} (${target.width}×${target.height}px)`);
  };

  const handleExportChatboxPng = () => {
    const box = renderChatbox(regularHead, {
      speakerName,
      dialogueText,
      promptText,
      showPrompt,
      layout,
      scale: 2,
    });
    const slug = (speakerName || 'chatbox').toLowerCase().replace(/[^a-z0-9]+/g, '-');
    downloadPngFromRaster(box, `${slug}-chatbox.png`);
    setExportStatus(`Exported ${slug}-chatbox.png (1038x284)`);
  };

  const handleExportChatheadGif = async (variant: 'regular' | 'full') => {
    if (!hasSequence) return;
    const isFull = variant === 'full';
    const slug = (speakerName || 'chathead').toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const filename = `${slug}-chathead-${variant}.gif`;
    const cachedBlob = isFull ? fullGifBlobRef.current : regularGifBlobRef.current;
    if (cachedBlob) {
      downloadBlob(cachedBlob, filename);
      setExportStatus(`Exported ${filename}`);
      return;
    }

    setIsExporting(true);
    setExportStatus(`Encoding animated transparent ${variant} chathead GIF…`);
    try {
      const frames = await onRenderSequenceFrames(renderScale, isFull);
      if (frames.length === 0) return;
      const gifBytes = encodeAnimatedGif(frames, true);
      downloadBlob(new Blob([new Uint8Array(gifBytes)], { type: 'image/gif' }), filename);
      setExportStatus(`Exported ${filename} (${frames.length} frames)`);
    } finally {
      setIsExporting(false);
    }
  };

  const handleExportChatboxGif = async () => {
    if (!hasSequence) return;
    const slug = (speakerName || 'chatbox').toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const filename = `${slug}-chatbox.gif`;
    if (chatboxGifBlobRef.current) {
      downloadBlob(chatboxGifBlobRef.current, filename);
      setExportStatus(`Exported ${filename}`);
      return;
    }

    setIsExporting(true);
    setExportStatus('Encoding animated OSRS chatbox GIF…');
    try {
      const headFrames = await onRenderSequenceFrames(1, false);
      if (headFrames.length === 0) return;
      const boxPoseCache = new Map<RasterOutput, RasterOutput>();
      const boxFrames = headFrames.map((f) => {
        let cachedBox = boxPoseCache.get(f.frame);
        if (!cachedBox) {
          cachedBox = renderChatbox(f.frame, {
            speakerName,
            dialogueText,
            promptText,
            showPrompt,
            layout,
            scale: 1,
          });
          boxPoseCache.set(f.frame, cachedBox);
        }
        return { frame: cachedBox, delayMs: f.delayMs };
      });
      const gifBytes = encodeAnimatedGif(boxFrames, false);
      downloadBlob(new Blob([new Uint8Array(gifBytes)], { type: 'image/gif' }), filename);
      setExportStatus(`Exported ${filename} (${boxFrames.length} frames)`);
    } finally {
      setIsExporting(false);
    }
  };

  const handleAddTurn = (e: React.FormEvent) => {
    e.preventDefault();
    const snapshot: RasterOutput | null = regularHead
      ? {
          width: regularHead.width,
          height: regularHead.height,
          pixels: new Uint8ClampedArray(regularHead.pixels),
          originX: regularHead.originX,
          originY: regularHead.originY,
          scale: regularHead.scale,
        }
      : null;

    setTurns((prev) => [
      ...prev,
      {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        speakerName,
        dialogueText,
        promptText,
        showPrompt,
        layout,
        snapshot,
      },
    ]);
  };

  const handleExportStripPng = () => {
    if (turns.length === 0) return;
    const boxes = turns.map((t) =>
      renderChatbox(t.snapshot, {
        speakerName: t.speakerName,
        dialogueText: t.dialogueText,
        promptText: t.promptText,
        showPrompt: t.showPrompt,
        layout: t.layout,
        scale: 2,
      })
    );
    const stacked = stackChatboxes(boxes, 8);
    downloadPngFromRaster(stacked, 'osrs-dialogue-strip.png');
    setExportStatus(`Exported osrs-dialogue-strip.png (${turns.length} turns)`);
  };

  return (
    <section className="card" aria-labelledby={formHeadingId}>
      <h2 id={formHeadingId}>Live Chathead &amp; OSRS Chatbox Preview</h2>

      <div className="preview-stage">
        <div className="preview-stage-header">
          <div className="check-option">
            <input
              id={fullToggleId}
              type="checkbox"
              checked={alwaysShowFullPreview}
              onChange={(e) => setAlwaysShowFullPreview(e.target.checked)}
            />
            <label htmlFor={fullToggleId}>Always show tight-cropped / full preview</label>
          </div>
          {hasSubstantialDifference && (
            <span className="preview-badge">Model exceeds standard 96×96 slot</span>
          )}
        </div>
        <div className="hint" style={{ paddingInline: '0.25rem' }}>
          Tip: Drag any animated GIF directly or use <strong>Download GIF</strong> below (browser Copy Image copies a single PNG frame).
        </div>

        <div className="preview-grid">
          <div className="preview-card">
            <div className="preview-card-title">
              <span>Regular (96×96 Slot)</span>
              {regularHead && (
                <span className="hint">
                  {regularHead.width}×{regularHead.height}px
                </span>
              )}
            </div>
            {regularPreviewUrl ? (
              <img
                src={regularPreviewUrl}
                className="pixel-canvas"
                style={{ maxWidth: 'min(100%, 192px)', maxHeight: 192, width: 'auto', height: 'auto' }}
                alt="Regular 96x96 slot OSRS chathead preview"
              />
            ) : (
              <div className="hint" style={{ paddingBlock: '2rem' }}>
                Select an NPC or Player to preview chathead
              </div>
            )}
            <div className="btn-row" style={{ width: '100%', flexDirection: 'column', alignItems: 'stretch' }}>
              <button
                type="button"
                className="primary compact"
                disabled={!regularHead || isExporting}
                onClick={() => handleExportChatheadPng('regular')}
              >
                Download Regular PNG{regularHead ? ` (${regularHead.width}×${regularHead.height}px)` : ''}
              </button>
              <button
                type="button"
                className="compact"
                disabled={!regularHead || !hasSequence || isExporting}
                onClick={() => void handleExportChatheadGif('regular')}
              >
                Download Regular GIF
              </button>
            </div>
          </div>

          {showFullCard && fullHead && (
            <div className="preview-card">
              <div className="preview-card-title">
                <span>Full Chathead (Unclipped)</span>
                <span className="preview-badge">
                  {isPlaying && hasSequence ? 'Max Envelope' : 'Tight-Cropped'}
                </span>
              </div>
              {fullPreviewUrl && (
                <img
                  src={fullPreviewUrl}
                  className="pixel-canvas"
                  style={{ maxWidth: 'min(100%, 220px)', maxHeight: 300, width: 'auto', height: 'auto' }}
                  alt="Full unclipped OSRS chathead preview"
                />
              )}
              <div className="btn-row" style={{ width: '100%', flexDirection: 'column', alignItems: 'stretch' }}>
                <button
                  type="button"
                  className="primary compact"
                  disabled={isExporting}
                  onClick={() => handleExportChatheadPng('full')}
                >
                  Download Full PNG ({fullHead.width}×{fullHead.height}px)
                </button>
                <button
                  type="button"
                  className="compact"
                  disabled={!hasSequence || isExporting}
                  onClick={() => void handleExportChatheadGif('full')}
                >
                  Download Full GIF
                  {fullGifDims ? ` (${fullGifDims.width}×${fullGifDims.height}px)` : ''}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="chatbox-stage">
        {chatboxPreviewUrl && (
          <img
            src={chatboxPreviewUrl}
            className="pixel-canvas chatbox-preview"
            width={519}
            height={142}
            alt="Rendered OSRS dialogue chatbox preview"
          />
        )}
      </div>

      <div className="btn-row" style={{ marginBottom: '1rem' }}>
        <button
          type="button"
          className="primary"
          disabled={isExporting}
          onClick={handleExportChatboxPng}
        >
          Download Chatbox PNG (2x)
        </button>
        <button
          type="button"
          disabled={!hasSequence || isExporting}
          onClick={() => void handleExportChatboxGif()}
        >
          Download Animated Chatbox GIF
        </button>
      </div>

      {exportStatus && (
        <div role="status" aria-live="polite" className="hint" style={{ marginBottom: '0.75rem' }}>
          {exportStatus}
        </div>
      )}

      <form
        aria-labelledby={formHeadingId}
        onSubmit={handleAddTurn}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && e.nativeEvent.isComposing) e.preventDefault();
        }}
      >
        <fieldset>
          <legend>Chatbox Layout Side</legend>
          <div className="radio-group">
            <div className="radio-option">
              <input
                id={layoutLeftId}
                type="radio"
                name="chatboxLayout"
                value="npc-left"
                checked={layout === 'npc-left'}
                onChange={() => setLayout('npc-left')}
              />
              <label htmlFor={layoutLeftId}>NPC Style (Chathead Left)</label>
            </div>
            <div className="radio-option">
              <input
                id={layoutRightId}
                type="radio"
                name="chatboxLayout"
                value="player-right"
                checked={layout === 'player-right'}
                onChange={() => setLayout('player-right')}
              />
              <label htmlFor={layoutRightId}>Player Style (Chathead Right)</label>
            </div>
            <div className="radio-option">
              <input
                id={layoutNoneId}
                type="radio"
                name="chatboxLayout"
                value="none"
                checked={layout === 'none'}
                onChange={() => setLayout('none')}
              />
              <label htmlFor={layoutNoneId}>Text Only</label>
            </div>
          </div>
        </fieldset>

        <div className="field">
          <label htmlFor={speakerId}>Speaker Name</label>
          <input
            id={speakerId}
            name="speakerName"
            type="text"
            value={speakerName}
            onChange={(e) => setSpeakerName(e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor={dialogueId}>Dialogue Message</label>
          <textarea
            id={dialogueId}
            name="dialogueText"
            value={dialogueText}
            onChange={(e) => setDialogueText(e.target.value)}
          />
          <span className="hint">
            Supports up to 4 lines and OSRS color tags like <code>&lt;col=800000&gt;red&lt;/col&gt;</code> or <code>&lt;col=0000ff&gt;blue&lt;/col&gt;</code>.
          </span>
        </div>

        <div className="checkbox-inline" style={{ marginBottom: '0.75rem' }}>
          <div className="check-option">
            <input
              id={promptCheckId}
              name="showPrompt"
              type="checkbox"
              checked={showPrompt}
              onChange={(e) => setShowPrompt(e.target.checked)}
            />
            <label htmlFor={promptCheckId}>Show continue prompt</label>
          </div>
        </div>

        {showPrompt && (
          <div className="field">
            <label htmlFor={promptInputId}>Continue Prompt Text</label>
            <input
              id={promptInputId}
              name="promptText"
              type="text"
              value={promptText}
              onChange={(e) => setPromptText(e.target.value)}
            />
          </div>
        )}

        <div className="btn-row">
          <button type="submit" className="compact">
            + Add Turn to Dialogue Strip
          </button>
          {turns.length > 0 && (
            <>
              <button type="button" className="primary compact" onClick={handleExportStripPng}>
                Export Strip PNG ({turns.length} turns)
              </button>
              <button type="button" className="compact" onClick={() => setTurns([])}>
                Clear Strip
              </button>
            </>
          )}
        </div>
      </form>

      {turns.length > 0 && (
        <div className="strip-list" aria-label="Queued dialogue strip turns">
          {turns.map((turn, idx) => (
            <div key={turn.id} className="strip-item">
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
                {turn.snapshot && (
                  <img
                    src={rasterToDataUrl(turn.snapshot)}
                    alt=""
                    width={40}
                    height={40}
                    style={{ imageRendering: 'pixelated', flexShrink: 0 }}
                  />
                )}
                <div>
                  <strong>
                    #{idx + 1} {turn.speakerName || '(Unnamed)'}
                  </strong>
                  <div className="hint">{turn.dialogueText.slice(0, 72)}</div>
                </div>
              </div>
              <button
                type="button"
                className="compact"
                onClick={() => setTurns((prev) => prev.filter((t) => t.id !== turn.id))}
                aria-label={`Remove turn ${idx + 1}`}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
};
