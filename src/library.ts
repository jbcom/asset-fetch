export interface OwnedPack {
  keyId: number;
  gameId: number;
  title: string;
  classification: string;
  shortText: string;
  url: string;
}

const MAX_RETRIES = 4;

/**
 * itch.io's API rate-limits paginated my-owned-keys requests (a full
 * library walk hit a real 429 during development of this package — the
 * prior per-repo scripts never handled this, they just crashed).
 * Retries on 429 with the response's Retry-After header when present,
 * otherwise exponential backoff (1s, 2s, 4s, 8s). Non-429 responses pass
 * through untouched — the caller's existing `!res.ok` handling covers them.
 */
async function fetchWithRetry(
  doRequest: () => Promise<Response>,
  page: number,
  sleepImpl: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))
): Promise<Response> {
  let lastResponse: Response | undefined;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await doRequest();
    if (res.status !== 429) return res;
    lastResponse = res;
    if (attempt === MAX_RETRIES) break;
    const retryAfterHeader = res.headers.get("retry-after");
    const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : Number.NaN;
    const backoffMs = Number.isFinite(retryAfterMs) ? retryAfterMs : 2 ** attempt * 1000;
    console.warn(
      `itch API page ${page}: rate limited (429), retrying in ${Math.round(backoffMs / 1000)}s (attempt ${attempt + 1}/${MAX_RETRIES})`
    );
    await sleepImpl(backoffMs);
  }
  return lastResponse as Response;
}

export interface FetchLibraryOptions {
  apiKey: string;
  /** Injected for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Safety bound on itch's paginated my-owned-keys endpoint. Default 40. */
  maxPages?: number;
  /** Injected for tests to avoid real waits during 429 backoff. */
  sleepImpl?: (ms: number) => Promise<void>;
}

const URL_SUSPICIOUS_RE = /itch\.io\/https?[a-z0-9-]*itchio/i;

/**
 * Some pack authors paste a URL into the URL field itself, producing
 * malformed entries like `https://author.itch.io/httpsauthoritchio`.
 * Strip those rather than carry dead links into a generated inventory
 * (bone-buster's fix, generalized).
 */
export function sanitizeItchUrl(url: unknown): string {
  if (typeof url !== "string" || url.length === 0) return "";
  if (URL_SUSPICIOUS_RE.test(url)) return "";
  if (/^https?:\/\//i.test(url)) return url;
  return "";
}

/**
 * Paginate itch.io's `my-owned-keys` endpoint into a flat list of owned
 * packs. Does not deduplicate — the same game can appear more than once
 * across multiple download keys (free + paid bundles, replacement keys);
 * callers that want one row per game should dedupe by `gameId`.
 */
export async function fetchOwnedLibrary(options: FetchLibraryOptions): Promise<OwnedPack[]> {
  const { apiKey, maxPages = 40, sleepImpl } = options;
  const doFetch = options.fetchImpl ?? fetch;
  const all: OwnedPack[] = [];

  for (let page = 1; page <= maxPages; page++) {
    const res = await fetchWithRetry(
      () => doFetch(`https://itch.io/api/1/${apiKey}/my-owned-keys?page=${page}`),
      page,
      sleepImpl
    );
    if (!res.ok) {
      throw new Error(`itch API page ${page} failed: HTTP ${res.status} ${res.statusText}`);
    }
    let data: { owned_keys?: unknown };
    try {
      data = (await res.json()) as { owned_keys?: unknown };
    } catch (e) {
      throw new Error(`itch API page ${page}: non-JSON response (${(e as Error).message})`);
    }
    const keys = Array.isArray(data.owned_keys) ? data.owned_keys : [];
    if (keys.length === 0) break;
    for (const k of keys as Array<Record<string, unknown>>) {
      const game = (k.game ?? {}) as Record<string, unknown>;
      all.push({
        keyId: k.id as number,
        gameId: game.id as number,
        title: (game.title as string) ?? "?",
        classification: (game.classification as string) ?? "?",
        shortText: (game.short_text as string) ?? "",
        url: sanitizeItchUrl(game.url),
      });
    }
  }
  return all;
}

/** One row per unique game, preferring the first-seen download key. */
export function dedupeByGame(packs: OwnedPack[]): OwnedPack[] {
  const seen = new Map<number, OwnedPack>();
  for (const p of packs) {
    if (!seen.has(p.gameId)) seen.set(p.gameId, p);
  }
  return [...seen.values()];
}

export type LibraryBucket = "audio" | "pixel-2d" | "3d-psx" | "tool" | "other";

/** Coarse content-type classification from title+description text. Callers
 * needing a game-specific taxonomy should filter/re-bucket the raw list
 * themselves — this only separates the three recurring asset
 * shapes (audio, 2D pixel art, 3D/voxel) from everything else. */
export function classifyPack(pack: OwnedPack): LibraryBucket {
  const text = `${pack.title} ${pack.shortText}`.toLowerCase();
  if (/audio|sfx|music|sound|bgm|ost/.test(text)) return "audio";
  if (/pixel|16x16|16-bit|32x32|sprite|tileset|tile set|top-down|topdown|rpg/.test(text)) {
    return "pixel-2d";
  }
  if (/psx|3d|voxel|low.?poly|glb|model/.test(text)) return "3d-psx";
  if (pack.classification === "tool") return "tool";
  return "other";
}

export interface SearchLibraryOptions {
  /** Case-insensitive substring/word match against title + shortText.
   * Omit to match every pack (useful combined with `bucket` alone). */
  query?: string;
  /** Restrict to one classifyPack() bucket. */
  bucket?: LibraryBucket;
}

/**
 * Query an already-fetched owned-library cache (the array
 * `fetchOwnedLibrary` returns, or `JSON.parse`d from
 * `.itch-cache/library.json`) by free-text query and/or content bucket —
 * so an allow-list author (human or agent) can find candidate packs by
 * name/keyword instead of scrolling the raw JSON. Local/offline: this
 * searches what you already own, not itch.io's public catalog (itch.io
 * doesn't expose a documented general-catalog search API — the `/api/1/
 * <key>/...` surface is scoped to owned keys).
 */
export function searchLibrary(packs: OwnedPack[], options: SearchLibraryOptions = {}): OwnedPack[] {
  const { query, bucket } = options;
  const needle = query?.trim().toLowerCase();
  return packs.filter((pack) => {
    if (bucket && classifyPack(pack) !== bucket) return false;
    if (!needle) return true;
    return `${pack.title} ${pack.shortText}`.toLowerCase().includes(needle);
  });
}
