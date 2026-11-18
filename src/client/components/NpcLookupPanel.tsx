import React, { useEffect, useId, useState } from 'react';
import { NpcDef, UnifiedCache } from '../../shared/cache/types';
import { ColorOverride } from '../../shared/renderer/ModelMesh';
import { hexToHsl16, hsl16ToHex } from '../../shared/renderer/OsrsMath';
import { ServerCacheProxy } from '../ClientCacheProxy';

interface NpcLookupPanelProps {
  cache: UnifiedCache | null;
  selectedNpc: NpcDef | null;
  palette: Array<{ hsl: number; count: number }>;
  colorOverrides: ColorOverride[];
  onSelectNpc: (npc: NpcDef) => void;
  onChangeOverrides: (overrides: ColorOverride[]) => void;
}

export const NpcLookupPanel: React.FC<NpcLookupPanelProps> = ({
  cache,
  selectedNpc,
  palette,
  colorOverrides,
  onSelectNpc,
  onChangeOverrides,
}) => {
  const searchInputId = useId();
  const chatheadFilterId = useId();
  const morphSelectId = useId();

  const [query, setQuery] = useState('');
  const [onlyChathead, setOnlyChathead] = useState(true);
  const [results, setResults] = useState<NpcDef[]>([]);
  const [isSearching, setIsSearching] = useState(false);

  useEffect(() => {
    if (!cache) {
      setResults([]);
      return;
    }

    let cancelled = false;
    setIsSearching(true);

    const run = async () => {
      try {
        let list: NpcDef[];
        if (cache instanceof ServerCacheProxy) {
          list = await cache.searchNpcs(query, onlyChathead, 150);
        } else {
          const all = await cache.getAllNpcs();
          const byId = new Map(all.map((n) => [n.id, n]));
          const q = query.trim().toLowerCase();
          list = all
            .filter((n) => {
              if (!n.name || n.name === 'null') return false;
              if (onlyChathead) {
                const hasSelf = n.chatheadModels.some((m) => m >= 0 && m !== 65535);
                const hasChild = n.multiChildren.some((c) => {
                  const ch = byId.get(c);
                  return ch ? ch.chatheadModels.some((m) => m >= 0 && m !== 65535) : false;
                });
                if (!hasSelf && !hasChild) return false;
              }
              if (q && !n.name.toLowerCase().includes(q) && !String(n.id).includes(q)) return false;
              return true;
            })
            .slice(0, 150);
        }

        if (!cancelled) {
          setResults(list);
          if (!selectedNpc && list.length > 0) {
            onSelectNpc(list[0]);
          }
        }
      } finally {
        if (!cancelled) setIsSearching(false);
      }
    };

    const timer = setTimeout(() => void run(), 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [cache, query, onlyChathead]);

  const overrideMap = new Map<number, number>(colorOverrides.map((o) => [o.from, o.to]));

  const handleSetOverride = (fromHsl: number, hexValue: string) => {
    const nextHsl = hexToHsl16(hexValue);
    const filtered = colorOverrides.filter((o) => o.from !== fromHsl);
    onChangeOverrides([...filtered, { from: fromHsl, to: nextHsl }]);
  };

  const handleResetColor = (fromHsl: number) => {
    onChangeOverrides(colorOverrides.filter((o) => o.from !== fromHsl));
  };

  const validMorphChildren = selectedNpc?.multiChildren.filter((id) => id >= 0) ?? [];

  return (
    <div className="tabpanel-inner">
      <search>
        <form onSubmit={(e) => e.preventDefault()} aria-label="Search NPCs">
          <div className="field">
            <label htmlFor={searchInputId}>Search NPC Name or ID</label>
            <input
              id={searchInputId}
              name="npcQuery"
              type="search"
              placeholder="e.g. Hans, Wise Old Man, TzTok-Jad, 3106"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && e.nativeEvent.isComposing) return;
              }}
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              enterKeyHint="search"
            />
          </div>

          <div className="checkbox-inline" style={{ marginBottom: '0.5rem' }}>
            <div className="check-option">
              <input
                id={chatheadFilterId}
                name="onlyChathead"
                type="checkbox"
                checked={onlyChathead}
                onChange={(e) => setOnlyChathead(e.target.checked)}
              />
              <label htmlFor={chatheadFilterId}>Only NPCs with dedicated chathead models</label>
            </div>
          </div>
        </form>
      </search>

      <div className="hint" role="status" aria-live="polite">
        {isSearching ? 'Searching NPCs…' : `${results.length} matching NPCs shown`}
      </div>

      <ul className="result-list" aria-label="Matching NPCs">
        {results.map((npc) => {
          const isActive = selectedNpc?.id === npc.id;
          return (
            <li key={npc.id}>
              <button
                type="button"
                className={`result-item-btn ${isActive ? 'active' : ''}`}
                onClick={() => onSelectNpc(npc)}
              >
                <span>{npc.name}</span>
                <span className="result-meta">
                  ID {npc.id}
                  {npc.combatLevel > 0 ? ` · Lvl ${npc.combatLevel}` : ''}
                </span>
              </button>
            </li>
          );
        })}
        {results.length === 0 && !isSearching && (
          <li style={{ padding: '0.75rem', color: 'var(--text-muted)' }}>
            No NPCs matched. Try unchecking the chathead filter or loading a full OSRS cache.
          </li>
        )}
      </ul>

      {selectedNpc && validMorphChildren.length > 0 && cache && (
        <div className="field">
          <label htmlFor={morphSelectId}>NPC Transform Variant</label>
          <select
            id={morphSelectId}
            className="brand-select"
            value={selectedNpc.id}
            onChange={(e) => {
              const nextId = Number(e.target.value);
              void cache.getNpc(nextId).then((found) => {
                if (found) onSelectNpc(found);
              });
            }}
          >
            <button type="button">
              <selectedcontent></selectedcontent>
            </button>
            {validMorphChildren.map((cid) => (
              <option key={cid} value={cid}>
                Variant NPC #{cid}
              </option>
            ))}
          </select>
        </div>
      )}

      {palette.length > 0 && (
        <fieldset>
          <legend>Model Color Swaps</legend>
          <div className="hint" style={{ marginBottom: '0.5rem' }}>
            Cache recolors are applied automatically. Adjust any model HSL color below:
          </div>
          {palette.slice(0, 6).map(({ hsl }) => {
            const currentHex = hsl16ToHex(overrideMap.get(hsl) ?? hsl);
            const hasOverride = overrideMap.has(hsl);
            return (
              <div key={hsl} className="color-override-row">
                <span className="color-chip" style={{ backgroundColor: hsl16ToHex(hsl) }} title={`Original HSL ${hsl}`} />
                <input
                  type="color"
                  aria-label={`Swap color HSL ${hsl}`}
                  value={currentHex}
                  onChange={(e) => handleSetOverride(hsl, e.target.value)}
                  style={{ minHeight: '48px', padding: '0.2rem', cursor: 'pointer' }}
                />
                <button
                  type="button"
                  className="compact"
                  disabled={!hasOverride}
                  onClick={() => handleResetColor(hsl)}
                >
                  Reset
                </button>
              </div>
            );
          })}
        </fieldset>
      )}
    </div>
  );
};
