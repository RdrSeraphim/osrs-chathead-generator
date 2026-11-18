import React, { useCallback, useEffect, useRef, useState } from "react";
import { buildStarterCache } from "../shared/cache/StarterCacheBuilder";
import {
  MemoryFileMapProvider,
  OsrsUnifiedCache,
} from "../shared/cache/UnifiedCacheLoader";
import { CacheSummary, NpcDef, UnifiedCache } from "../shared/cache/types";
import {
  CompatibleSeqEntry,
  computeSequenceUnionBounds,
  findChatheadSequences,
  PlayerCompositionConfig,
  RelativeBounds,
  renderAnimatedFramePair,
  RenderedChatheadPair,
  renderSequenceFrames,
  ResolvedChathead,
  resolveNpcChathead,
  resolvePlayerChathead,
} from "../shared/renderer/ChatheadPipeline";
import { ColorOverride } from "../shared/renderer/ModelMesh";
import {
  CameraParams,
  OSRS_NPC_CHATHEAD_CAMERA,
  OSRS_PLAYER_CHATHEAD_CAMERA,
} from "../shared/renderer/SoftwareRasterizer";
import {
  BrowserCacheSummaryMeta,
  clearSavedBrowserCache,
  getAdminToken,
  getSavedBrowserCacheMeta,
  restoreSavedBrowserCache,
  ServerCacheProxy,
  setAdminToken,
} from "./ClientCacheProxy";
import { AnimationControls } from "./components/AnimationControls";
import { CacheLoaderPanel } from "./components/CacheLoaderPanel";
import { ChatboxComposer } from "./components/ChatboxComposer";
import { NpcLookupPanel } from "./components/NpcLookupPanel";
import { PlayerLookupPanel } from "./components/PlayerLookupPanel";

type SubjectMode = "npc" | "player";

const USER_PREFS_STORAGE_KEY = "osrs_user_prefs_v1";

const DEFAULT_PLAYER_CONFIG: PlayerCompositionConfig = {
  gender: "male",
  headKitId: 215,
  jawKitId: 11,
  helmItemId: 0,
  skinHsl: 4550,
  hairHsl: 6798,
  extraColors: [],
};

interface SavedUserPrefs {
  mode: SubjectMode;
  playerName: string;
  playerConfig: PlayerCompositionConfig;
}

function loadSavedUserPrefs(): SavedUserPrefs {
  const fallback: SavedUserPrefs = {
    mode: "npc",
    playerName: "Seraphim IRL",
    playerConfig: DEFAULT_PLAYER_CONFIG,
  };
  try {
    if (typeof localStorage === "undefined") return fallback;
    const raw = localStorage.getItem(USER_PREFS_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<SavedUserPrefs>;
    const mode: SubjectMode = parsed.mode === "player" ? "player" : "npc";
    const playerName =
      typeof parsed.playerName === "string" && parsed.playerName.length <= 12
        ? parsed.playerName
        : fallback.playerName;
    const pc = parsed.playerConfig;
    const playerConfig: PlayerCompositionConfig =
      pc &&
      (pc.gender === "male" || pc.gender === "female") &&
      typeof pc.headKitId === "number" &&
      typeof pc.jawKitId === "number" &&
      typeof pc.helmItemId === "number" &&
      typeof pc.skinHsl === "number" &&
      typeof pc.hairHsl === "number"
        ? {
            gender: pc.gender,
            headKitId: pc.headKitId,
            jawKitId: pc.jawKitId,
            helmItemId: pc.helmItemId,
            skinHsl: pc.skinHsl,
            hairHsl: pc.hairHsl,
            extraColors: Array.isArray(pc.extraColors) ? pc.extraColors : [],
          }
        : DEFAULT_PLAYER_CONFIG;
    return { mode, playerName, playerConfig };
  } catch {
    return fallback;
  }
}

interface CacheStatusResponse {
  loaded: boolean;
  activePath: string;
  summary: CacheSummary | null;
  candidateDirs: string[];
  error?: string | null;
}

export const App: React.FC = () => {
  const [initialPrefs] = useState<SavedUserPrefs>(() => loadSavedUserPrefs());
  const [cache, setCache] = useState<UnifiedCache | null>(null);
  const [summary, setSummary] = useState<CacheSummary | null>(null);
  const [activePath, setActivePath] = useState("./cache");
  const [candidateDirs, setCandidateDirs] = useState<string[]>([]);
  const [cacheBusy, setCacheBusy] = useState(false);
  const [cacheStatusMsg, setCacheStatusMsg] = useState(
    "Loading starter OSRS cache…",
  );
  const [isUsingBrowserCache, setIsUsingBrowserCache] = useState(false);
  const [savedCacheMeta, setSavedCacheMeta] = useState<BrowserCacheSummaryMeta | null>(() =>
    getSavedBrowserCacheMeta(),
  );
  const [adminToken, setAdminTokenState] = useState<string>(() => getAdminToken());

  const [mode, setMode] = useState<SubjectMode>(initialPrefs.mode);

  // NPC State
  const [selectedNpc, setSelectedNpc] = useState<NpcDef | null>(null);
  const [npcOverrides, setNpcOverrides] = useState<ColorOverride[]>([]);

  // Player State
  const [playerName, setPlayerName] = useState(initialPrefs.playerName);
  const [playerConfig, setPlayerConfig] = useState<PlayerCompositionConfig>(
    initialPrefs.playerConfig,
  );

  // Resolved Mesh & Animation State
  const [resolved, setResolved] = useState<ResolvedChathead | null>(null);
  const [sequences, setSequences] = useState<CompatibleSeqEntry[]>([]);
  const [seqsLoaded, setSeqsLoaded] = useState(false);
  const [selectedSeqId, setSelectedSeqId] = useState<number | null>(591);
  const [frameIndex, setFrameIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(true);
  const [camera, setCamera] = useState<CameraParams>({
    ...OSRS_NPC_CHATHEAD_CAMERA,
  });
  const [renderScale, setRenderScale] = useState(2);
  const [seqUnionBoundsState, setSeqUnionBoundsState] = useState<{
    key: string;
    bounds: RelativeBounds | null;
  }>({ key: "", bounds: null });
  const [currentPair, setCurrentPair] = useState<RenderedChatheadPair | null>(
    null,
  );

  const npcPanelRef = useRef<HTMLDivElement>(null);
  const playerPanelRef = useRef<HTMLDivElement>(null);
  const npcTabRef = useRef<HTMLButtonElement>(null);
  const playerTabRef = useRef<HTMLButtonElement>(null);

  // Sync hidden="until-found" find-in-page matches (Modern Web Guidance: tabs)
  useEffect(() => {
    const npcEl = npcPanelRef.current;
    const playerEl = playerPanelRef.current;
    const onNpcMatch = () => setMode("npc");
    const onPlayerMatch = () => setMode("player");
    npcEl?.addEventListener("beforematch", onNpcMatch);
    playerEl?.addEventListener("beforematch", onPlayerMatch);
    return () => {
      npcEl?.removeEventListener("beforematch", onNpcMatch);
      playerEl?.removeEventListener("beforematch", onPlayerMatch);
    };
  }, []);

  // Persist subject mode and player customization in localStorage
  useEffect(() => {
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(
          USER_PREFS_STORAGE_KEY,
          JSON.stringify({ mode, playerName, playerConfig }),
        );
      }
    } catch {
      // ignore storage failures
    }
  }, [mode, playerName, playerConfig]);

  const loadServerDefaultCache = useCallback(async (isCancelled?: () => boolean) => {
    try {
      const res = await fetch("/api/cache/status");
      if (!res.ok) throw new Error("API unavailable");
      const data = (await res.json()) as CacheStatusResponse;
      if (isCancelled?.()) return;
      setActivePath(data.activePath);
      setCandidateDirs(data.candidateDirs);
      if (data.loaded && data.summary) {
        const proxy = new ServerCacheProxy(data.summary);
        setCache(proxy);
        setSummary(data.summary);
        setIsUsingBrowserCache(false);
        setCacheStatusMsg(`Loaded server cache (${data.activePath})`);
        return;
      }
    } catch {
      // Fallback to client-side starter cache
    }

    if (isCancelled?.()) return;
    const built = buildStarterCache();
    const mem = await OsrsUnifiedCache.open(
      new MemoryFileMapProvider(built.dat2Files.entries()),
      "Built-in Starter Cache",
    );
    const memSum = await mem.getSummary();
    if (!isCancelled?.()) {
      setCache(mem);
      setSummary(memSum);
      setIsUsingBrowserCache(true);
      setActivePath("Built-in Starter Cache");
      setCacheStatusMsg("Loaded built-in starter cache in browser memory.");
    }
  }, []);

  // Initialize from persisted browser cache if present, otherwise server default cache
  useEffect(() => {
    let cancelled = false;
    const init = async () => {
      if (getSavedBrowserCacheMeta()) {
        const saved = await restoreSavedBrowserCache();
        if (cancelled) return;
        if (saved) {
          const savedSummary = await saved.getSummary();
          if (cancelled) return;
          setCache(saved);
          setSummary(savedSummary);
          setIsUsingBrowserCache(true);
          setActivePath("Browser Local Cache");
          setSavedCacheMeta(getSavedBrowserCacheMeta());
          setCacheStatusMsg(`Restored saved browser cache: ${savedSummary.sourceLabel}`);
          // Also fetch allowlisted candidate labels so "Use Server Default Cache" stays informed
          void fetch("/api/cache/status")
            .then((r) => (r.ok ? r.json() : null))
            .then((data: CacheStatusResponse | null) => {
              if (!cancelled && data) setCandidateDirs(data.candidateDirs ?? []);
            })
            .catch(() => undefined);
          return;
        }
        setSavedCacheMeta(null);
      }
      await loadServerDefaultCache(() => cancelled);
    };
    void init();
    return () => {
      cancelled = true;
    };
  }, [loadServerDefaultCache]);

  const handleLoadServerPath = async (dirPath: string) => {
    setCacheBusy(true);
    setCacheStatusMsg(`Loading server cache (${dirPath})…`);
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (adminToken) headers["X-OSRS-Admin-Token"] = adminToken;
      const res = await fetch("/api/cache/load-path", {
        method: "POST",
        headers,
        body: JSON.stringify({ dirPath }),
      });
      const json = (await res.json()) as {
        summary?: CacheSummary;
        activePath?: string;
        error?: string;
      };
      if (!res.ok || !json.summary) {
        throw new Error(json.error ?? "Failed to load server cache.");
      }
      setSelectedNpc(null);
      setNpcOverrides([]);
      setActivePath(json.activePath ?? dirPath);
      setSummary(json.summary);
      setCache(new ServerCacheProxy(json.summary));
      setIsUsingBrowserCache(false);
      setCacheStatusMsg(
        `Loaded server cache (${json.activePath ?? dirPath})`,
      );
    } catch (err) {
      setCacheStatusMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setCacheBusy(false);
    }
  };

  const handleDownloadOpenRs2 = async () => {
    setCacheBusy(true);
    setCacheStatusMsg(
      "Downloading latest Old School RuneScape cache from OpenRS2 (may take ~20-60s)…",
    );
    try {
      const headers: Record<string, string> = {};
      if (adminToken) headers["X-OSRS-Admin-Token"] = adminToken;
      const res = await fetch("/api/cache/download-openrs2", {
        method: "POST",
        headers,
      });
      const json = (await res.json()) as {
        summary?: CacheSummary;
        activePath?: string;
        openrs2Id?: number;
        error?: string;
      };
      if (!res.ok || !json.summary) {
        throw new Error(json.error ?? "OpenRS2 download failed.");
      }
      setSelectedNpc(null);
      setNpcOverrides([]);
      setActivePath(json.activePath ?? "./cache");
      setSummary(json.summary);
      setCache(new ServerCacheProxy(json.summary));
      setIsUsingBrowserCache(false);
      setCacheStatusMsg(
        `Downloaded and loaded OpenRS2 OSRS cache #${json.openrs2Id ?? ""} (rev ${json.summary.revision})`,
      );
    } catch (err) {
      setCacheStatusMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setCacheBusy(false);
    }
  };

  const handleLoadBrowserCache = (
    nextCache: UnifiedCache,
    nextSummary: CacheSummary,
  ) => {
    setSelectedNpc(null);
    setNpcOverrides([]);
    setCache(nextCache);
    setSummary(nextSummary);
    setIsUsingBrowserCache(true);
    setActivePath("Browser Local Cache");
    setSavedCacheMeta(getSavedBrowserCacheMeta());
    setCacheStatusMsg(`Loaded & saved browser cache: ${nextSummary.sourceLabel}`);
  };

  const handleUseServerCache = async () => {
    setCacheBusy(true);
    setSelectedNpc(null);
    setNpcOverrides([]);
    try {
      await loadServerDefaultCache();
    } finally {
      setCacheBusy(false);
    }
  };

  const handleClearSavedCache = async () => {
    setCacheBusy(true);
    try {
      await clearSavedBrowserCache();
      setSavedCacheMeta(null);
      if (isUsingBrowserCache) {
        setSelectedNpc(null);
        setNpcOverrides([]);
        await loadServerDefaultCache();
      } else {
        setCacheStatusMsg("Cleared saved browser cache.");
      }
    } finally {
      setCacheBusy(false);
    }
  };

  const handleChangeAdminToken = (nextToken: string) => {
    setAdminTokenState(nextToken);
    setAdminToken(nextToken);
  };

  // Load compatible sequences whenever cache changes
  useEffect(() => {
    if (!cache) {
      setSequences([]);
      setSeqsLoaded(false);
      return;
    }
    let cancelled = false;
    setSeqsLoaded(false);
    const loadSeqs = async () => {
      const list =
        cache instanceof ServerCacheProxy
          ? await cache.getSeqEntries()
          : await findChatheadSequences(cache);
      if (!cancelled) {
        setSequences(list);
        setSelectedSeqId((prev) =>
          list.length > 0 && !list.some((s) => s.seq.id === prev)
            ? list[0].seq.id
            : prev
        );
        setSeqsLoaded(true);
      }
    };
    void loadSeqs();
    return () => {
      cancelled = true;
    };
  }, [cache]);

  // Resolve chathead 3D mesh for current mode (NPC vs Player)
  useEffect(() => {
    if (!cache) {
      setResolved(null);
      return;
    }
    let cancelled = false;
    const resolve = async () => {
      let next: ResolvedChathead | null = null;
      if (mode === "npc" && selectedNpc) {
        next = await resolveNpcChathead(cache, selectedNpc, npcOverrides);
      } else if (mode === "player") {
        next = await resolvePlayerChathead(cache, playerConfig);
      }
      if (!cancelled) {
        setResolved(next);
        if (next) {
          setCamera({ ...next.defaultCamera });
        } else {
          setCamera(
            mode === "npc"
              ? { ...OSRS_NPC_CHATHEAD_CAMERA }
              : { ...OSRS_PLAYER_CHATHEAD_CAMERA },
          );
        }
      }
    };
    void resolve();
    return () => {
      cancelled = true;
    };
  }, [cache, mode, selectedNpc, npcOverrides, playerConfig]);

  const activeSeqEntry =
    sequences.find((s) => s.seq.id === selectedSeqId) ?? null;
  const isAnimatingMultiFrame = Boolean(
    isPlaying && activeSeqEntry && activeSeqEntry.frameCount > 1,
  );
  const seqBoundsKey =
    cache && resolved && isAnimatingMultiFrame && activeSeqEntry
      ? `${resolved.modelIds.join(",")}-${activeSeqEntry.seq.id}-${renderScale}-${camera.rotationX}-${camera.rotationY}-${camera.rotationZ}-${camera.modelZoom}`
      : "";

  // Compute maximum envelope across all poses when playing a multi-frame animation so full preview box never wiggles
  useEffect(() => {
    if (
      !cache ||
      !resolved ||
      !isAnimatingMultiFrame ||
      !activeSeqEntry ||
      !seqBoundsKey
    ) {
      setSeqUnionBoundsState({ key: "", bounds: null });
      return;
    }
    let cancelled = false;
    const keySnapshot = seqBoundsKey;
    const compute = async () => {
      const bounds = await computeSequenceUnionBounds(
        cache,
        resolved.mesh,
        camera,
        activeSeqEntry.seq,
        96,
        renderScale,
      );
      if (!cancelled) {
        setSeqUnionBoundsState({ key: keySnapshot, bounds });
      }
    };
    void compute();
    return () => {
      cancelled = true;
    };
  }, [
    cache,
    resolved,
    camera,
    activeSeqEntry,
    renderScale,
    isAnimatingMultiFrame,
    seqBoundsKey,
  ]);

  // Render regular (96x96 slot) and tight-cropped / envelope-clamped full chathead pair
  useEffect(() => {
    if (!cache || !resolved || !seqsLoaded) {
      setCurrentPair(null);
      return;
    }
    if (isAnimatingMultiFrame && seqUnionBoundsState.key !== seqBoundsKey) {
      return;
    }
    let cancelled = false;
    const unionBounds = isAnimatingMultiFrame
      ? seqUnionBoundsState.bounds
      : null;
    const draw = async () => {
      const pair = await renderAnimatedFramePair(
        cache,
        resolved.mesh,
        camera,
        activeSeqEntry?.seq ?? null,
        frameIndex,
        96,
        renderScale,
        unionBounds,
      );
      if (!cancelled) setCurrentPair(pair);
    };
    void draw();
    return () => {
      cancelled = true;
    };
  }, [
    cache,
    resolved,
    seqsLoaded,
    camera,
    activeSeqEntry,
    frameIndex,
    renderScale,
    isAnimatingMultiFrame,
    seqBoundsKey,
    seqUnionBoundsState,
  ]);

  const handleRenderSequenceFrames = useCallback(
    async (exportScale: number, fullUncropped = false) => {
      if (!cache || !resolved || !activeSeqEntry) return [];
      return renderSequenceFrames(
        cache,
        resolved.mesh,
        camera,
        activeSeqEntry.seq,
        96,
        exportScale,
        fullUncropped,
      );
    },
    [cache, resolved, camera, activeSeqEntry],
  );

  const handleLoadCustomSeqId = useCallback(
    async (seqId: number): Promise<string | null> => {
      if (!cache) return "No cache loaded.";
      const existing = sequences.find((s) => s.seq.id === seqId);
      if (existing) {
        setSelectedSeqId(seqId);
        setFrameIndex(0);
        setIsPlaying(true);
        return null;
      }
      const seq = await cache.getSeq(seqId);
      if (
        !seq ||
        (seq.frameIds.length === 0 && seq.chatFrameIds.length === 0)
      ) {
        return `Sequence #${seqId} not found or has no frame data.`;
      }
      const frameCount = Math.max(seq.frameIds.length, seq.chatFrameIds.length);
      const entry: CompatibleSeqEntry = {
        seq,
        label: seq.name ? `${seq.name} (#${seq.id})` : `Sequence #${seq.id}`,
        hasChatFrames: seq.chatFrameIds.length > 0,
        frameCount,
      };
      setSequences((prev) => [entry, ...prev]);
      setSelectedSeqId(seqId);
      setFrameIndex(0);
      setIsPlaying(true);
      return null;
    },
    [cache, sequences],
  );

  const handleSwitchMode = (nextMode: SubjectMode) => {
    setMode(nextMode);
    setFrameIndex(0);
  };

  // Selection follows focus on tab arrow keys when polyfill/native focusgroup moves focus
  const handleTabKeyUp = (nextMode: SubjectMode) => {
    if (
      document.activeElement ===
      (nextMode === "npc" ? npcTabRef.current : playerTabRef.current)
    ) {
      handleSwitchMode(nextMode);
    }
  };

  const speakerDefault =
    mode === "npc" ? (selectedNpc?.name ?? "NPC") : playerName || "Player";
  const layoutDefault = mode === "npc" ? "npc-left" : "player-right";

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <h1>OSRS Chathead &amp; Dialogue Generator</h1>
          <p>
            Authentic Jagex Software Rasterizer (<code>zoom 796</code> ·{" "}
            <code>pitch 40</code> · NPC yaw <code>1882</code> right / Player yaw{" "}
            <code>166</code> left) from real cache data.
          </p>
        </div>
        <div className="status-pill" role="status" aria-live="polite">
          <span
            className={`status-dot ${cacheBusy ? "loading" : cache ? "" : "error"}`}
          />
          <span>
            {summary
              ? `${summary.format} · rev ${summary.revision}`
              : "No cache"}
          </span>
        </div>
      </header>

      <main className="studio-grid">
        <div className="panel-column">
          <CacheLoaderPanel
            summary={summary}
            activePath={activePath}
            candidateDirs={candidateDirs}
            isBusy={cacheBusy}
            statusMessage={cacheStatusMsg}
            isUsingBrowserCache={isUsingBrowserCache}
            savedCacheMeta={savedCacheMeta}
            adminToken={adminToken}
            onLoadServerPath={handleLoadServerPath}
            onDownloadOpenRs2={handleDownloadOpenRs2}
            onLoadBrowserCache={handleLoadBrowserCache}
            onUseServerCache={handleUseServerCache}
            onClearSavedCache={handleClearSavedCache}
            onChangeAdminToken={handleChangeAdminToken}
          />

          <section className="card" aria-label="Character Subject Lookup">
            <div className="tabs">
              <div
                className="tablist"
                aria-label="Chathead Subject Mode"
                {...({ focusgroup: "tablist nomemory" } as Record<
                  string,
                  string
                >)}
              >
                <button
                  ref={npcTabRef}
                  type="button"
                  id="tab-npc"
                  role="tab"
                  aria-selected={mode === "npc"}
                  {...(mode === "npc"
                    ? ({ focusgroupstart: "" } as Record<string, string>)
                    : {})}
                  onClick={() => handleSwitchMode("npc")}
                  onFocus={() => handleSwitchMode("npc")}
                  onKeyUp={() => handleTabKeyUp("npc")}
                >
                  NPC Lookup (Faces Right)
                </button>
                <button
                  ref={playerTabRef}
                  type="button"
                  id="tab-player"
                  role="tab"
                  aria-selected={mode === "player"}
                  {...(mode === "player"
                    ? ({ focusgroupstart: "" } as Record<string, string>)
                    : {})}
                  onClick={() => handleSwitchMode("player")}
                  onFocus={() => handleSwitchMode("player")}
                  onKeyUp={() => handleTabKeyUp("player")}
                >
                  Player Lookup (Faces Left)
                </button>
              </div>

              <div className="tabs-container">
                <div
                  ref={npcPanelRef}
                  role="tabpanel"
                  aria-labelledby="tab-npc"
                  style={{ gridArea: "1 / 1" }}
                  hidden={
                    mode === "npc"
                      ? undefined
                      : ("until-found" as unknown as boolean)
                  }
                >
                  <NpcLookupPanel
                    cache={cache}
                    selectedNpc={selectedNpc}
                    palette={mode === "npc" ? (resolved?.palette ?? []) : []}
                    colorOverrides={npcOverrides}
                    onSelectNpc={(npc) => {
                      setSelectedNpc(npc);
                      setNpcOverrides([]);
                    }}
                    onChangeOverrides={setNpcOverrides}
                  />
                </div>

                <div
                  ref={playerPanelRef}
                  role="tabpanel"
                  aria-labelledby="tab-player"
                  style={{ gridArea: "1 / 1" }}
                  hidden={
                    mode === "player"
                      ? undefined
                      : ("until-found" as unknown as boolean)
                  }
                >
                  <PlayerLookupPanel
                    cache={cache}
                    config={playerConfig}
                    playerName={playerName}
                    onChangePlayerName={setPlayerName}
                    onChangeConfig={setPlayerConfig}
                  />
                </div>
              </div>
            </div>
          </section>
        </div>

        <div className="panel-column">
          <ChatboxComposer
            regularHead={currentPair?.regular ?? null}
            fullHead={currentPair?.full ?? null}
            hasSubstantialDifference={
              currentPair?.hasSubstantialDifference ?? false
            }
            defaultSpeakerName={speakerDefault}
            defaultLayout={layoutDefault}
            hasSequence={Boolean(
              activeSeqEntry && activeSeqEntry.frameCount > 0,
            )}
            isPlaying={isPlaying}
            renderScale={renderScale}
            onRenderSequenceFrames={handleRenderSequenceFrames}
          />

          <AnimationControls
            sequences={sequences}
            selectedSeqId={selectedSeqId}
            frameIndex={frameIndex}
            isPlaying={isPlaying}
            camera={camera}
            defaultCamera={
              resolved?.defaultCamera ??
              (mode === "npc"
                ? OSRS_NPC_CHATHEAD_CAMERA
                : OSRS_PLAYER_CHATHEAD_CAMERA)
            }
            usedFallbackModels={resolved?.usedFallbackModels ?? false}
            scale={renderScale}
            onSelectSeq={(id) => {
              setSelectedSeqId(id);
              setFrameIndex(0);
              setIsPlaying(id !== null);
            }}
            onLoadCustomSeqId={handleLoadCustomSeqId}
            onChangeFrame={(idx) => {
              setIsPlaying(false);
              setFrameIndex(idx);
            }}
            onTogglePlay={() => setIsPlaying((p) => !p)}
            onChangeCamera={setCamera}
            onChangeScale={setRenderScale}
          />
        </div>
      </main>
    </div>
  );
};
