import React, { useEffect, useId, useMemo, useState } from 'react';
import { ItemDef, KitDef, UnifiedCache } from '../../shared/cache/types';
import { PLAYER_HAIR_COLORS, PLAYER_SKIN_COLORS } from '../../shared/constants/playerColors';
import { getKitDisplayName, PlayerCompositionConfig } from '../../shared/renderer/ChatheadPipeline';
import { hsl16ToHex } from '../../shared/renderer/OsrsMath';
import { ServerCacheProxy } from '../ClientCacheProxy';

interface PlayerLookupPanelProps {
  cache: UnifiedCache | null;
  config: PlayerCompositionConfig;
  playerName: string;
  onChangePlayerName: (name: string) => void;
  onChangeConfig: (next: PlayerCompositionConfig) => void;
}

interface HiscoresLookupResult {
  username: string;
  foundInHiscores: boolean;
  totalLevel: number | null;
  combatStats: Record<string, number> | null;
  appearanceNote: string;
  suggested: {
    gender: 'male' | 'female';
    headIndex: number;
    jawIndex: number;
    skinIndex: number;
    hairIndex: number;
    helmItemId: number | null;
  };
}

export const PlayerLookupPanel: React.FC<PlayerLookupPanelProps> = ({
  cache,
  config,
  playerName,
  onChangePlayerName,
  onChangeConfig,
}) => {
  const lookupHeadingId = useId();
  const rsnInputId = useId();
  const rsnHelpId = useId();
  const maleRadioId = useId();
  const femaleRadioId = useId();
  const headKitSelectId = useId();
  const jawKitSelectId = useId();
  const helmSearchId = useId();

  const [rsnInput, setRsnInput] = useState(playerName || 'Zezima');
  const [lookupStatus, setLookupStatus] = useState<string>('');
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [isLookingUp, setIsLookingUp] = useState(false);

  const [kits, setKits] = useState<KitDef[]>([]);
  const [helmQuery, setHelmQuery] = useState('');
  const [helmResults, setHelmResults] = useState<ItemDef[]>([]);

  useEffect(() => {
    if (!cache) {
      setKits([]);
      return;
    }
    void cache.getAllKits().then((all) => {
      setKits(all.filter((k) => k.chatheadModels.some((m) => m >= 0 && m !== 65535)));
    });
  }, [cache]);

  const headKits = useMemo(() => {
    const part = config.gender === 'male' ? 0 : 7;
    return kits.filter((k) => k.bodyPartId === part);
  }, [kits, config.gender]);

  const jawKits = useMemo(() => {
    const part = config.gender === 'male' ? 1 : 8;
    return kits.filter((k) => k.bodyPartId === part);
  }, [kits, config.gender]);

  // Ensure selected head/jaw kits remain valid when gender or cache changes
  useEffect(() => {
    if (headKits.length === 0) return;
    const hasHead = headKits.some((k) => k.id === config.headKitId);
    const hasJaw = jawKits.some((k) => k.id === config.jawKitId);
    if (!hasHead || (config.gender === 'male' && !hasJaw && jawKits.length > 0)) {
      onChangeConfig({
        ...config,
        headKitId: hasHead ? config.headKitId : headKits[0]?.id ?? null,
        jawKitId:
          config.gender === 'male'
            ? hasJaw
              ? config.jawKitId
              : jawKits[0]?.id ?? null
            : null,
      });
    }
  }, [headKits, jawKits, config.gender]);

  // Search headgear items
  useEffect(() => {
    if (!cache) {
      setHelmResults([]);
      return;
    }
    let cancelled = false;
    const run = async () => {
      let list: ItemDef[];
      if (cache instanceof ServerCacheProxy) {
        list = await cache.searchItems(helmQuery, true, 120);
      } else {
        const all = await cache.getAllItems();
        const q = helmQuery.trim().toLowerCase();
        list = all
          .filter((it) => {
            if (!it.name || it.name === 'null' || it.noteTemplate >= 0 || it.placeholderTemplate >= 0) return false;
            const hasChat =
              it.maleChatheadModel >= 0 ||
              it.femaleChatheadModel >= 0 ||
              it.maleChatheadModel1 >= 0 ||
              it.femaleChatheadModel1 >= 0;
            if (!hasChat) return false;
            if (q && !it.name.toLowerCase().includes(q) && !String(it.id).includes(q)) return false;
            return true;
          })
          .slice(0, 120);
      }
      if (!cancelled) setHelmResults(list);
    };
    const t = setTimeout(() => void run(), 120);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [cache, helmQuery]);

  const handleLookupSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLookupError(null);
    const clean = rsnInput.trim();
    if (!clean || clean.length > 12) {
      setLookupError('Enter a RuneScape username (1–12 characters).');
      return;
    }

    setIsLookingUp(true);
    try {
      const res = await fetch(`/api/player/lookup/${encodeURIComponent(clean)}`);
      const data = (await res.json()) as HiscoresLookupResult & { error?: string };
      if (!res.ok) {
        setLookupError(data.error ?? 'Lookup failed.');
        return;
      }

      onChangePlayerName(data.username);
      const nextHead =
        headKits.length > 0
          ? headKits[data.suggested.headIndex % headKits.length].id
          : config.headKitId;
      const nextJaw =
        jawKits.length > 0
          ? jawKits[data.suggested.jawIndex % jawKits.length].id
          : config.jawKitId;
      const nextSkin = PLAYER_SKIN_COLORS[data.suggested.skinIndex % PLAYER_SKIN_COLORS.length].hsl;
      const nextHair = PLAYER_HAIR_COLORS[data.suggested.hairIndex % PLAYER_HAIR_COLORS.length].hsl;

      onChangeConfig({
        ...config,
        headKitId: nextHead,
        jawKitId: config.gender === 'male' ? nextJaw : null,
        skinHsl: nextSkin,
        hairHsl: nextHair,
        helmItemId: data.suggested.helmItemId ?? config.helmItemId,
      });

      setLookupStatus(
        data.foundInHiscores
          ? `Found "${data.username}" on OSRS Hiscores (Total Level ${data.totalLevel ?? '?'}). ${data.appearanceNote}`
          : `"${data.username}" not found on live Hiscores (or offline). Applied seeded player look — customize hair, jaw, and headgear below.`
      );
    } catch {
      onChangePlayerName(clean);
      setLookupStatus(`Loaded "${clean}" locally. Customize hair, jaw, headgear, and HSL colors below.`);
    } finally {
      setIsLookingUp(false);
    }
  };

  const selectedHelm = helmResults.find((h) => h.id === config.helmItemId) ?? null;

  return (
    <div className="tabpanel-inner">
      <form
        aria-labelledby={lookupHeadingId}
        onSubmit={handleLookupSubmit}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && e.nativeEvent.isComposing) e.preventDefault();
        }}
      >
        <h3 id={lookupHeadingId} style={{ marginTop: 0, fontSize: '1rem', color: 'var(--accent)' }}>
          Player Username &amp; Appearance (Faces Left · Yaw 166)
        </h3>
        <div className="field">
          <label htmlFor={rsnInputId}>RuneScape Username (RSN)</label>
          <div className="input-row">
            <input
              id={rsnInputId}
              name="rsn"
              type="text"
              maxLength={12}
              value={rsnInput}
              onChange={(e) => {
                setRsnInput(e.target.value);
                setLookupError(null);
              }}
              aria-invalid={lookupError ? 'true' : undefined}
              aria-describedby={lookupError ? `${rsnHelpId} rsn-err` : rsnHelpId}
              autoComplete="username"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              enterKeyHint="search"
            />
            <button type="submit" className="primary compact" disabled={isLookingUp}>
              {isLookingUp ? 'Looking up…' : 'Lookup'}
            </button>
          </div>
          <span id={rsnHelpId} className="hint">
            1–12 characters. Queries OSRS Hiscores and builds a left-facing player chathead.
          </span>
          {lookupError && (
            <span id="rsn-err" className="error-text" role="alert">
              {lookupError}
            </span>
          )}
        </div>
      </form>

      {lookupStatus && (
        <div role="status" aria-live="polite" className="hint" style={{ marginBottom: '0.85rem' }}>
          {lookupStatus}
        </div>
      )}

      <fieldset>
        <legend>Character Body Type</legend>
        <div className="radio-group">
          <div className="radio-option">
            <input
              id={maleRadioId}
              type="radio"
              name="playerGender"
              value="male"
              checked={config.gender === 'male'}
              onChange={() => onChangeConfig({ ...config, gender: 'male' })}
            />
            <label htmlFor={maleRadioId}>Male</label>
          </div>
          <div className="radio-option">
            <input
              id={femaleRadioId}
              type="radio"
              name="playerGender"
              value="female"
              checked={config.gender === 'female'}
              onChange={() => onChangeConfig({ ...config, gender: 'female', jawKitId: null })}
            />
            <label htmlFor={femaleRadioId}>Female</label>
          </div>
        </div>
      </fieldset>

      <div className="field">
        <label htmlFor={headKitSelectId}>Head &amp; Hair Style (Kit)</label>
        <select
          id={headKitSelectId}
          name="headKit"
          className="brand-select"
          value={config.headKitId ?? ''}
          onChange={(e) =>
            onChangeConfig({
              ...config,
              headKitId: e.target.value === '' ? null : Number(e.target.value),
            })
          }
        >
          <button type="button">
            <selectedcontent></selectedcontent>
          </button>
          {headKits.map((kit) => (
            <option key={kit.id} value={kit.id}>
              {getKitDisplayName(kit)}
            </option>
          ))}
        </select>
      </div>

      {config.gender === 'male' && (
        <div className="field">
          <label htmlFor={jawKitSelectId}>Beard / Jaw Style (Kit)</label>
          <select
            id={jawKitSelectId}
            name="jawKit"
            className="brand-select"
            value={config.jawKitId ?? ''}
            onChange={(e) =>
              onChangeConfig({
                ...config,
                jawKitId: e.target.value === '' ? null : Number(e.target.value),
              })
            }
          >
            <button type="button">
              <selectedcontent></selectedcontent>
            </button>
            <option value="">None (No Jaw Kit)</option>
            {jawKits.map((kit) => (
              <option key={kit.id} value={kit.id}>
                {getKitDisplayName(kit)}
              </option>
            ))}
          </select>
        </div>
      )}

      <fieldset>
        <legend>Skin Tone (Makeover Mage HSL)</legend>
        <div className="swatch-grid">
          {PLAYER_SKIN_COLORS.map((sw) => (
            <button
              key={sw.index}
              type="button"
              className={`swatch-btn ${config.skinHsl === sw.hsl ? 'active' : ''}`}
              title={sw.name}
              aria-label={`Skin tone: ${sw.name}`}
              aria-pressed={config.skinHsl === sw.hsl}
              onClick={() => onChangeConfig({ ...config, skinHsl: sw.hsl })}
            >
              <span className="swatch-fill" style={{ backgroundColor: hsl16ToHex(sw.hsl) }} />
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend>Hair &amp; Beard Color (HSL)</legend>
        <div className="swatch-grid">
          {PLAYER_HAIR_COLORS.map((sw) => (
            <button
              key={sw.index}
              type="button"
              className={`swatch-btn ${config.hairHsl === sw.hsl ? 'active' : ''}`}
              title={sw.name}
              aria-label={`Hair color: ${sw.name}`}
              aria-pressed={config.hairHsl === sw.hsl}
              onClick={() => onChangeConfig({ ...config, hairHsl: sw.hsl })}
            >
              <span className="swatch-fill" style={{ backgroundColor: hsl16ToHex(sw.hsl) }} />
            </button>
          ))}
        </div>
      </fieldset>

      <search>
        <form onSubmit={(e) => e.preventDefault()} aria-label="Search Headgear Items">
          <div className="field">
            <label htmlFor={helmSearchId}>Headgear / Helmet / Hat (Optional)</label>
            <div className="input-row">
              <input
                id={helmSearchId}
                name="helmQuery"
                type="search"
                placeholder="e.g. Partyhat, Slayer helmet, Dragon med"
                value={helmQuery}
                onChange={(e) => setHelmQuery(e.target.value)}
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                enterKeyHint="search"
              />
              <button
                type="button"
                className="compact"
                disabled={config.helmItemId === null}
                onClick={() => onChangeConfig({ ...config, helmItemId: null })}
              >
                No Helm
              </button>
            </div>
            <span className="hint">
              Active headgear:{' '}
              <strong>
                {selectedHelm ? `${selectedHelm.name} (#${selectedHelm.id})` : config.helmItemId !== null ? `Item #${config.helmItemId}` : 'None'}
              </strong>
            </span>
          </div>
        </form>
      </search>

      <ul className="result-list" aria-label="Headgear Items">
        {helmResults.map((item) => {
          const isActive = config.helmItemId === item.id;
          return (
            <li key={item.id}>
              <button
                type="button"
                className={`result-item-btn ${isActive ? 'active' : ''}`}
                onClick={() => onChangeConfig({ ...config, helmItemId: item.id })}
              >
                <span>{item.name}</span>
                <span className="result-meta">ID {item.id}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
};
