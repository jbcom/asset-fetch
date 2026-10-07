/**
 * One row from itch.io's `profile/owned-keys` endpoint: a single download key
 * granting access to a game. The same game can appear more than once (a
 * free key and a later paid-bundle key, a replacement key, etc.) — see
 * {@link dedupeByGame} to collapse to one row per game.
 */
export interface OwnedPack {
  /** itch.io's id for this specific download key (not the game itself). */
  keyId: number;
  /** itch.io's id for the underlying game — stable across the game's
   * multiple download keys, so it's the right field to dedupe/group on. */
  gameId: number;
  /** Game title, as itch.io returns it. */
  title: string;
  /** itch.io's classification field for the game (e.g. "game", "tool",
   * "asset") — distinct from {@link classifyPack}'s content-bucket guess,
   * which is inferred from title/description text. */
  classification: string;
  /** Short description text, used alongside `title` for search/classification. */
  shortText: string;
  /** The game's itch.io page URL, sanitized via {@link sanitizeItchUrl}
   * (empty string if the source value was malformed or non-http(s)). */
  url: string;
}

const MAX_RETRIES = 4;

function retryAfterMilliseconds(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1000 : undefined;
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

/**
 * itch.io's API rate-limits paginated owned-keys requests, so a full library
 * walk can hit a 429. Retries on 429 with the response's Retry-After header when present,
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
    const retryAfterMs = retryAfterMilliseconds(res.headers.get("retry-after"));
    const backoffMs = retryAfterMs ?? 2 ** attempt * 1000;
    console.warn(
      `itch API page ${page}: rate limited (429), retrying in ${Math.round(backoffMs / 1000)}s (attempt ${attempt + 1}/${MAX_RETRIES})`
    );
    await sleepImpl(backoffMs);
  }
  return lastResponse as Response;
}

/** Options for {@link fetchOwnedLibrary}. */
export interface FetchLibraryOptions {
  /** itch.io API key — see {@link readItchApiKey} for the standard way to
   * resolve one from the environment or a `.env` file. */
  apiKey: string;
  /** Injected for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Safety bound on itch's paginated profile/owned-keys endpoint. Default 40. */
  maxPages?: number;
  /** Injected for tests to avoid real waits during 429 backoff. */
  sleepImpl?: (ms: number) => Promise<void>;
}

const URL_SUSPICIOUS_RE = /itch\.io\/https?[a-z0-9-]*itchio/i;

/**
 * Some pack authors paste a URL into the URL field itself, producing
 * malformed entries like `https://author.itch.io/httpsauthoritchio`.
 * Strip those rather than carry dead links into a generated inventory.
 */
export function sanitizeItchUrl(url: unknown): string {
  if (typeof url !== "string" || url.length === 0) return "";
  if (URL_SUSPICIOUS_RE.test(url)) return "";
  if (/^https?:\/\//i.test(url)) return url;
  return "";
}

/**
 * Paginate itch.io's modern `profile/owned-keys` endpoint into a flat list of owned
 * packs. Does not deduplicate — the same game can appear more than once
 * across multiple download keys (free + paid bundles, replacement keys);
 * callers that want one row per game should dedupe by `gameId`.
 */
export async function fetchOwnedLibrary(options: FetchLibraryOptions): Promise<OwnedPack[]> {
  const { apiKey, maxPages = 40, sleepImpl } = options;
  if (!apiKey.trim()) throw new Error("itch API key must not be empty");
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) {
    throw new Error("maxPages must be a positive integer");
  }
  const doFetch = options.fetchImpl ?? fetch;
  const all: OwnedPack[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const res = await fetchWithRetry(
      () =>
        doFetch(`https://api.itch.io/profile/owned-keys?page=${page}`, {
          headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(30_000),
        }),
      page,
      sleepImpl
    );
    if (!res.ok) {
      throw new Error(`itch API page ${page} failed: HTTP ${res.status} ${res.statusText}`);
    }
    let data: unknown;
    try {
      data = await res.json();
    } catch (e) {
      throw new Error(`itch API page ${page}: non-JSON response (${(e as Error).message})`);
    }
    const keys =
      typeof data === "object" &&
      data !== null &&
      "owned_keys" in data &&
      Array.isArray(data.owned_keys)
        ? data.owned_keys
        : [];
    if (keys.length === 0) break;
    for (const [index, value] of keys.entries()) {
      if (typeof value !== "object" || value === null) {
        throw new Error(`itch API page ${page}: owned_keys[${index}] is not an object`);
      }
      const k = value as Record<string, unknown>;
      if (typeof k.id !== "number" || !Number.isSafeInteger(k.id)) {
        throw new Error(`itch API page ${page}: owned_keys[${index}] has an invalid key id`);
      }
      if (typeof k.game !== "object" || k.game === null) {
        throw new Error(`itch API page ${page}: owned_keys[${index}] has no game object`);
      }
      const game = k.game as Record<string, unknown>;
      if (typeof game.id !== "number" || !Number.isSafeInteger(game.id)) {
        throw new Error(`itch API page ${page}: owned_keys[${index}] has an invalid game id`);
      }
      all.push({
        keyId: k.id,
        gameId: game.id,
        title: typeof game.title === "string" ? game.title : "?",
        classification: typeof game.classification === "string" ? game.classification : "?",
        shortText: typeof game.short_text === "string" ? game.short_text : "",
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

/** Coarse content-type bucket assigned by {@link classifyPack} — the three
 * recurring asset shapes this package cares about (`audio`, `pixel-2d`,
 * `3d-psx`), itch.io's own `tool` classification, or `other` for anything
 * that doesn't match. */
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

/** Filter options for {@link searchLibrary}. Both fields are optional and
 * combine with AND semantics — a pack must satisfy both when both are given. */
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
 * doesn't expose a documented general-catalog search API).
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
