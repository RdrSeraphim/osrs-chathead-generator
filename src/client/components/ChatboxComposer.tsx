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
  currentHead: RasterOutput | null;
  defaultSpeakerName: string;
  defaultLayout: ChatboxLayout;
  hasSequence: boolean;
  onRenderSequenceFrames: (scale: number) => Promise<Array<{ frame: RasterOutput; delayMs: number }>>;
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
  currentHead,
  defaultSpeakerName,
  defaultLayout,
  hasSequence,
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

  const [speakerName, setSpeakerName] = useState(defaultSpeakerName);
  const [dialogueText, setDialogueText] = useState(
    'Hello adventurer! Use <col=800000>OSRS tags</col> or pick any NPC or Player chathead.'
  );
  const [showPrompt, setShowPrompt] = useState(true);
  const [promptText, setPromptText] = useState('Click here to continue');
  const [layout, setLayout] = useState<ChatboxLayout>(defaultLayout);
  const [turns, setTurns] = useState<DialogueTurn[]>([]);
  const [isExporting, setIsExporting] = useState(false);
  const [exportStatus, setExportStatus] = useState('');

  const headCanvasRef = useRef<HTMLCanvasElement>(null);
  const boxCanvasRef = useRef<HTMLCanvasElement>(null);

  // Sync speaker name & layout when switching subject unless user typed custom name
  useEffect(() => {
    setSpeakerName(defaultSpeakerName);
  }, [defaultSpeakerName]);

  useEffect(() => {
    setLayout(defaultLayout);
  }, [defaultLayout]);

  // Draw standalone chathead preview
  useEffect(() => {
    const canvas = headCanvasRef.current;
    if (!canvas || !currentHead) return;
    canvas.width = currentHead.width;
    canvas.height = currentHead.height;
    const ctx = canvas.getContext('2d')!;
    const img = new ImageData(new Uint8ClampedArray(currentHead.pixels), currentHead.width, currentHead.height);
    ctx.putImageData(img, 0, 0);
  }, [currentHead]);

  // Draw live 519x142 OSRS chatbox preview
  useEffect(() => {
    const canvas = boxCanvasRef.current;
    if (!canvas) return;
    const box = renderChatbox(currentHead, {
      speakerName,
      dialogueText,
      promptText,
      showPrompt,
      layout,
      scale: 1,
    });
    canvas.width = box.width;
    canvas.height = box.height;
    const ctx = canvas.getContext('2d')!;
    const img = new ImageData(new Uint8ClampedArray(box.pixels), box.width, box.height);
    ctx.putImageData(img, 0, 0);
  }, [currentHead, speakerName, dialogueText, promptText, showPrompt, layout]);

  const handleExportChatheadPng = () => {
    if (!currentHead) return;
    const slug = (speakerName || 'chathead').toLowerCase().replace(/[^a-z0-9]+/g, '-');
    downloadPngFromRaster(currentHead, `${slug}-chathead.png`);
    setExportStatus(`Exported ${slug}-chathead.png (${currentHead.width}x${currentHead.height})`);
  };

  const handleExportChatboxPng = () => {
    const box = renderChatbox(currentHead, {
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

  const handleExportChatheadGif = async () => {
    if (!hasSequence) return;
    setIsExporting(true);
    setExportStatus('Encoding animated transparent chathead GIF…');
    try {
      const frames = await onRenderSequenceFrames(2);
      const gifBytes = encodeAnimatedGif(frames, true);
      const slug = (speakerName || 'chathead').toLowerCase().replace(/[^a-z0-9]+/g, '-');
      downloadBlob(new Blob([new Uint8Array(gifBytes)], { type: 'image/gif' }), `${slug}-chathead.gif`);
      setExportStatus(`Exported ${slug}-chathead.gif (${frames.length} frames)`);
    } finally {
      setIsExporting(false);
    }
  };

  const handleExportChatboxGif = async () => {
    if (!hasSequence) return;
    setIsExporting(true);
    setExportStatus('Encoding animated OSRS chatbox GIF…');
    try {
      const headFrames = await onRenderSequenceFrames(1);
      const boxFrames = headFrames.map((f) => ({
        frame: renderChatbox(f.frame, {
          speakerName,
          dialogueText,
          promptText,
          showPrompt,
          layout,
          scale: 1,
        }),
        delayMs: f.delayMs,
      }));
      const gifBytes = encodeAnimatedGif(boxFrames, false);
      const slug = (speakerName || 'chatbox').toLowerCase().replace(/[^a-z0-9]+/g, '-');
      downloadBlob(new Blob([new Uint8Array(gifBytes)], { type: 'image/gif' }), `${slug}-chatbox.gif`);
      setExportStatus(`Exported ${slug}-chatbox.gif (${boxFrames.length} frames)`);
    } finally {
      setIsExporting(false);
    }
  };

  const handleAddTurn = (e: React.FormEvent) => {
    e.preventDefault();
    const snapshot = currentHead
      ? {
          width: currentHead.width,
          height: currentHead.height,
          pixels: new Uint8ClampedArray(currentHead.pixels),
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
        <div>
          <canvas
            ref={headCanvasRef}
            className="pixel-canvas"
            style={{ width: 160, height: 160 }}
            aria-label="Rendered OSRS chathead preview"
          />
        </div>
        <div className="btn-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
          <button
            type="button"
            className="primary"
            disabled={!currentHead || isExporting}
            onClick={handleExportChatheadPng}
          >
            Download Chathead PNG
          </button>
          <button
            type="button"
            disabled={!currentHead || !hasSequence || isExporting}
            onClick={() => void handleExportChatheadGif()}
          >
            Download Animated Chathead GIF
          </button>
        </div>
      </div>

      <div className="chatbox-stage">
        <canvas
          ref={boxCanvasRef}
          className="pixel-canvas"
          style={{ width: 519, height: 142 }}
          aria-label="Rendered OSRS dialogue chatbox preview"
        />
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
                    style={{ imageRendering: 'pixelated' }}
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
