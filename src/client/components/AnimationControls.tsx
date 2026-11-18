import React, { useId, useState } from 'react';
import { CompatibleSeqEntry } from '../../shared/renderer/ChatheadPipeline';
import { CameraParams } from '../../shared/renderer/SoftwareRasterizer';

interface AnimationControlsProps {
  sequences: CompatibleSeqEntry[];
  selectedSeqId: number | null;
  frameIndex: number;
  isPlaying: boolean;
  camera: CameraParams;
  defaultCamera: CameraParams;
  usedFallbackModels: boolean;
  scale: number;
  onSelectSeq: (seqId: number | null) => void;
  onLoadCustomSeqId: (seqId: number) => Promise<string | null>;
  onChangeFrame: (frameIndex: number) => void;
  onTogglePlay: () => void;
  onChangeCamera: (next: CameraParams) => void;
  onChangeScale: (scale: number) => void;
}

export const AnimationControls: React.FC<AnimationControlsProps> = ({
  sequences,
  selectedSeqId,
  frameIndex,
  isPlaying,
  camera,
  defaultCamera,
  usedFallbackModels,
  scale,
  onSelectSeq,
  onLoadCustomSeqId,
  onChangeFrame,
  onTogglePlay,
  onChangeCamera,
  onChangeScale,
}) => {
  const seqSelectId = useId();
  const customSeqId = useId();
  const scrubberId = useId();
  const zoomId = useId();
  const yawId = useId();
  const pitchId = useId();
  const scaleId = useId();

  const [seqIdInput, setSeqIdInput] = useState('');
  const [seqError, setSeqError] = useState<string | null>(null);

  const activeEntry = sequences.find((s) => s.seq.id === selectedSeqId) ?? null;
  const maxFrames = activeEntry ? Math.max(1, activeEntry.frameCount) : 1;
  const clampedFrame = Math.min(frameIndex, maxFrames - 1);

  const handleLoadSeqById = async (e: React.FormEvent) => {
    e.preventDefault();
    setSeqError(null);
    const id = Number(seqIdInput.trim());
    if (!Number.isInteger(id) || id < 0) {
      setSeqError('Enter a valid non-negative Sequence ID.');
      return;
    }
    const err = await onLoadCustomSeqId(id);
    if (err) setSeqError(err);
  };

  return (
    <section className="card" aria-label="Animation and Camera Controls">
      <h2>Animation &amp; Frame Selection</h2>

      {usedFallbackModels && (
        <div className="hint" style={{ color: 'var(--accent)', marginBottom: '0.75rem' }}>
          This NPC has no dedicated <code>chatheadModels</code> in the cache; showing world model with auto-fit framing.
        </div>
      )}

      <div className="field">
        <label htmlFor={seqSelectId}>Chathead Expression / Sequence</label>
        <select
          id={seqSelectId}
          name="sequenceId"
          className="brand-select"
          value={selectedSeqId ?? ''}
          onChange={(e) => {
            const val = e.target.value;
            onSelectSeq(val === '' ? null : Number(val));
          }}
        >
          <button type="button">
            <selectedcontent></selectedcontent>
          </button>
          <option value="">Static Pose (No Animation)</option>
          {sequences.map((entry) => (
            <option key={entry.seq.id} value={entry.seq.id}>
              {entry.label} ({entry.frameCount} frames)
            </option>
          ))}
        </select>
      </div>

      <form
        aria-label="Load Sequence by ID"
        onSubmit={handleLoadSeqById}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && e.nativeEvent.isComposing) e.preventDefault();
        }}
      >
        <div className="field">
          <label htmlFor={customSeqId}>Load Any Sequence ID (for NPC/Monster Chatheads)</label>
          <div className="input-row">
            <input
              id={customSeqId}
              name="customSeqId"
              type="text"
              inputMode="numeric"
              placeholder="e.g. 588, 591, 9802"
              value={seqIdInput}
              onChange={(e) => {
                setSeqIdInput(e.target.value);
                setSeqError(null);
              }}
              aria-invalid={seqError ? 'true' : undefined}
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              enterKeyHint="go"
            />
            <button type="submit" className="compact">
              Load Seq
            </button>
          </div>
          {seqError && (
            <span className="error-text" role="alert">
              {seqError}
            </span>
          )}
        </div>
      </form>

      {activeEntry && (
        <div className="field">
          <label htmlFor={scrubberId}>
            Specific Frame: <strong>{clampedFrame + 1}</strong> / {maxFrames}
          </label>
          <div className="timeline-bar">
            <button
              type="button"
              className="compact primary"
              onClick={onTogglePlay}
            >
              {isPlaying ? 'Pause' : 'Play'}
            </button>
            <button
              type="button"
              className="compact"
              onClick={() =>
                onChangeFrame((clampedFrame - 1 + maxFrames) % maxFrames)
              }
              aria-label="Previous frame"
            >
              Prev
            </button>
            <input
              id={scrubberId}
              type="range"
              min={0}
              max={maxFrames - 1}
              value={clampedFrame}
              onChange={(e) => onChangeFrame(Number(e.target.value))}
            />
            <button
              type="button"
              className="compact"
              onClick={() => onChangeFrame((clampedFrame + 1) % maxFrames)}
              aria-label="Next frame"
            >
              Next
            </button>
          </div>
        </div>
      )}

      <fieldset>
        <legend>Authentic OSRS Camera &amp; Output Scale</legend>
        <div className="camera-grid">
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor={yawId}>Yaw (0–2047)</label>
            <input
              id={yawId}
              type="number"
              min={0}
              max={2047}
              value={camera.rotationY}
              onChange={(e) =>
                onChangeCamera({ ...camera, rotationY: Number(e.target.value) || 0 })
              }
            />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor={pitchId}>Pitch (0–2047)</label>
            <input
              id={pitchId}
              type="number"
              min={0}
              max={2047}
              value={camera.rotationX}
              onChange={(e) =>
                onChangeCamera({ ...camera, rotationX: Number(e.target.value) || 0 })
              }
            />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor={zoomId}>Model Zoom</label>
            <input
              id={zoomId}
              type="number"
              min={150}
              max={4000}
              value={camera.modelZoom}
              onChange={(e) =>
                onChangeCamera({ ...camera, modelZoom: Number(e.target.value) || 796 })
              }
            />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor={scaleId}>Render Scale</label>
            <select
              id={scaleId}
              className="brand-select"
              value={scale}
              onChange={(e) => onChangeScale(Number(e.target.value))}
            >
              <button type="button">
                <selectedcontent></selectedcontent>
              </button>
              <option value={1}>1x (96px)</option>
              <option value={2}>2x (192px)</option>
              <option value={3}>3x (288px)</option>
              <option value={4}>4x (384px)</option>
            </select>
          </div>
        </div>

        <div className="btn-row" style={{ marginTop: '0.75rem' }}>
          <button
            type="button"
            className="compact"
            onClick={() => onChangeCamera({ ...defaultCamera })}
          >
            Reset OSRS Camera ({defaultCamera.rotationY === 1882 ? 'NPC Right' : 'Player Left'})
          </button>
          <button
            type="button"
            className="compact"
            onClick={() =>
              onChangeCamera({
                ...camera,
                rotationY: camera.rotationY === 1882 ? 166 : 1882,
              })
            }
          >
            Flip Left / Right ({camera.rotationY === 1882 ? 'Face Left' : 'Face Right'})
          </button>
        </div>
      </fieldset>
    </section>
  );
};
