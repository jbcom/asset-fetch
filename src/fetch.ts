import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { downloadHttpsFile } from "./http.js";
import { fileMatches, requireHttpsUrl } from "./integrity.js";
import { assertExtractionContained, assertWithin } from "./safety.js";

/** One file itch.io offers for a given game/download-key, as returned by
 * the `/api/1/key/game/<id>/uploads` endpoint. */
export interface ItchUpload {
  /** itch.io's id for this upload — used to request its signed download URL. */
  id: number;
  /** Filename as itch.io reports it. Never used as-is for a destination
   * path — {@link fetchItchAssets} runs it through `basename()` first, so a
   * malicious `filename` (e.g. containing `../`) can't zip-slip outside
   * the target directory. */
  filename: string;
  /** File size in bytes, used both to size-check an existing local file
   * (idempotent skip) and to verify a completed download. */
  size: number;
  /** MD5 hash of the file contents, when itch.io provides one. Used
   * alongside `size` to decide whether an already-downloaded file can be
   * skipped; a missing hash falls back to a size-only check. */
  md5_hash?: string;
}

/** One owned pack selected for download — the minimal fields
 * {@link fetchItchAssets} needs, typically a filtered slice of the
 * {@link OwnedPack} array from {@link fetchOwnedLibrary}. */
export interface PackToFetch {
  /** The download key id granting access to this pack (from {@link OwnedPack.keyId}). */
  keyId: number;
  /** The underlying game's id (from {@link OwnedPack.gameId}). */
  gameId: number;
  /** Pack/game title — also used to derive the per-pack filename prefix
   * via {@link slugify}. */
  title: string;
}

export interface FetchAssetsOptions {
  /** ITCH_API_KEY, resolved by the caller (see apiKey.ts). */
  apiKey: string;
  /** Packs to download, already filtered to the caller's allow-list. */
  packs: PackToFetch[];
  /** Directory archives (.zip/.rar/.7z) are written to. Created if missing. */
  archivesDir: string;
  /** Directory loose (non-archive) audio files are written to, one
   * subdirectory per pack slug. Created if missing. */
  looseDir: string;
  /** List what would be downloaded without writing anything. */
  dry?: boolean;
  /** Injected for tests. */
  apiGetImpl?: (path: string) => Promise<unknown>;
  /** Injected for tests — replaces the real backoff delay between apiGet retries. */
  retrySleepImpl?: (ms: number) => Promise<void>;
  /** Injected HTTP implementation for itch API requests and downloads. */
  fetchImpl?: typeof fetch;
  /** Injected for tests or custom download transports. */
  downloadImpl?: (url: string, destination: string) => Promise<void>;
}

/** Tally returned by {@link fetchItchAssets} summarizing one batch run. */
export interface FetchAssetsResult {
  /** Number of uploads newly written to disk (or, in `dry` mode, that
   * would have been). */
  downloaded: number;
  /** Number of uploads left untouched because an existing file already
   * matched on size (and md5, when itch.io provided one). */
  skipped: number;
  /** Number of packs/uploads that could not be completed — no usable
   * uploads, an exhausted apiGet retry, a non-https download URL, or a
   * post-download size mismatch. */
  failed: number;
  /** Resolved paths of every archive (`.zip`/`.rar`/`.7z`) that is now
   * present in `archivesDir` — downloaded this run or already skipped as
   * up to date — ready to hand to {@link extractArchives}. */
  archives: string[];
}

const ARCHIVE_RE = /\.(zip|rar|7z)$/i;
const LOOSE_RE = /\.(wav|mp3|ogg|flac)$/i;

function packSlug(pack: PackToFetch): string {
  const readable = slugify(pack.title) || "pack";
  return `${readable}-${pack.gameId}`;
}

function spawnOutputText(output: string | Buffer | null | undefined): string {
  return typeof output === "string" ? output : "";
}

/**
 * Lowercase a string and collapse every run of non-alphanumeric characters
 * into a single hyphen, trimming leading/trailing hyphens — used to turn a
 * pack title or archive filename (e.g. `"UI Sound Effects Pack – 40
 * Sounds"`) into a filesystem-safe, human-readable directory/prefix name
 * (`"ui-sound-effects-pack-40-sounds"`). Not reversible and not guaranteed
 * unique — {@link fetchItchAssets} relies on it only for readability, not
 * as an identity key.
 */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

async function defaultApiGet(
  apiKey: string,
  path: string,
  fetchImpl: typeof fetch
): Promise<unknown> {
  const response = await fetchImpl(`https://itch.io${path}`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok)
    throw new Error(`itch API request failed: HTTP ${response.status} ${response.statusText}`);
  try {
    return await response.json();
  } catch (error) {
    throw new Error(`itch API returned invalid JSON for ${path}: ${(error as Error).message}`);
  }
}

const API_MAX_RETRIES = 3;

/**
 * A transient network failure on itch.io's API is common enough in practice
 * that one blip should not abort a multi-pack batch. Wrap every apiGet call
 * with a short retry; callers that want the
 * `failed` counter (rather than a thrown error) to reflect an exhausted
 * retry should catch around fetchItchAssets as a whole — retry exhaustion
 * here still throws, matching apiGet's existing contract.
 */
async function withApiRetry<T>(
  fn: () => Promise<T>,
  sleepImpl: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= API_MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (attempt === API_MAX_RETRIES) break;
      await sleepImpl(2 ** attempt * 500);
    }
  }
  throw lastError;
}

/**
 * Download the archive uploads for each owned pack into `archivesDir`, falling
 * back to supported loose audio uploads when a pack has no archive.
 * TOCTOU-safe idempotency: reads the existing destination file ONCE and
 * compares size+md5 rather than checking existence then re-reading — a
 * missing file just throws ENOENT, caught below, and falls through to
 * download. Every download and redirect is pinned to HTTPS; filenames are
 * basename()-stripped so a malicious upload.filename can't escape the target
 * directory. Downloads land in a private temporary directory and are moved
 * into place only after their size and optional MD5 match, so a failed request
 * never replaces a previously valid file or leaves a partial destination.
 */
export async function fetchItchAssets(options: FetchAssetsOptions): Promise<FetchAssetsResult> {
  const { apiKey, packs, dry = false } = options;
  const archivesDir = resolve(options.archivesDir);
  const looseDir = resolve(options.looseDir);
  const fetchImpl = options.fetchImpl ?? fetch;
  const rawApiGet =
    options.apiGetImpl ?? ((path: string) => defaultApiGet(apiKey, path, fetchImpl));
  const download =
    options.downloadImpl ??
    ((url: string, destination: string) =>
      downloadHttpsFile(url, destination, { fetchImpl, label: "itch download URL" }));
  const apiGet = (path: string) => withApiRetry(() => rawApiGet(path), options.retrySleepImpl);

  if (!dry) {
    mkdirSync(archivesDir, { recursive: true });
    mkdirSync(looseDir, { recursive: true });
  }

  let downloaded = 0;
  let skipped = 0;
  let failed = 0;
  const archives: string[] = [];

  for (const pack of packs) {
    let uploadsResp: { uploads?: ItchUpload[] };
    try {
      uploadsResp = (await apiGet(
        `/api/1/key/game/${pack.gameId}/uploads?download_key_id=${pack.keyId}`
      )) as { uploads?: ItchUpload[] };
    } catch {
      // Retries (withApiRetry) already exhausted — count this pack as
      // failed and move on rather than aborting the whole batch.
      failed++;
      continue;
    }
    const all = uploadsResp?.uploads ?? [];
    const archiveUploads = all.filter((u) => ARCHIVE_RE.test(u.filename ?? ""));
    const uploads =
      archiveUploads.length > 0
        ? archiveUploads
        : all.filter((u) => LOOSE_RE.test(u.filename ?? ""));

    if (uploads.length === 0) {
      failed++;
      continue;
    }

    for (const upload of uploads) {
      const isArchive = ARCHIVE_RE.test(upload.filename);
      const directorySlug = packSlug(pack);
      const safeName = basename(upload.filename);
      const dest = isArchive
        ? join(archivesDir, `${directorySlug}__${safeName}`)
        : join(looseDir, directorySlug, safeName);
      assertWithin(dest, [isArchive ? archivesDir : looseDir]);

      const expected = { size: upload.size, md5: upload.md5_hash };
      if (fileMatches(dest, expected)) {
        skipped++;
        if (isArchive) archives.push(dest);
        continue;
      }

      if (dry) {
        downloaded++;
        if (isArchive) archives.push(dest);
        continue;
      }

      let dlInfo: { url?: string };
      try {
        dlInfo = (await apiGet(
          `/api/1/key/upload/${upload.id}/download?download_key_id=${pack.keyId}`
        )) as { url?: string };
      } catch {
        failed++;
        continue;
      }
      if (!dlInfo?.url) {
        failed++;
        continue;
      }
      try {
        requireHttpsUrl(dlInfo.url, "itch download URL");
      } catch {
        failed++;
        continue;
      }

      if (!isArchive) mkdirSync(join(looseDir, directorySlug), { recursive: true });

      const tempDir = mkdtempSync(
        join(isArchive ? archivesDir : join(looseDir, directorySlug), ".asset-fetch-")
      );
      const temporary = join(tempDir, "download.part");
      let valid = false;
      try {
        await download(dlInfo.url, temporary);
        valid = fileMatches(temporary, expected);
        if (valid) renameSync(temporary, dest);
      } catch {
        valid = false;
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
      if (!valid) {
        failed++;
        continue;
      }
      downloaded++;
      if (isArchive) archives.push(dest);
    }
  }

  return { downloaded, skipped, failed, archives };
}

/**
 * Extract every archive in archivesDir into extractedDir/<slug>. .zip via
 * the system `unzip`; .rar via node-unrar-js; .7z via the system `7z` if
 * present. Archive entry names are checked before extraction, and the
 * extracted tree is audited afterwards ({@link assertExtractionContained}), so
 * an archive whose symlink member points outside its directory is rejected as
 * failed. Successful work is staged and then moved into place with a source
 * marker; failed or interrupted extraction therefore cannot masquerade as a
 * valid cache entry, and never replaces an earlier good one.
 */
export async function extractArchives(
  archivesDir: string,
  extractedDir: string
): Promise<{ extracted: string[]; failed: string[] }> {
  const resolvedArchivesDir = resolve(archivesDir);
  const resolvedExtractedDir = resolve(extractedDir);
  mkdirSync(resolvedExtractedDir, { recursive: true });
  const extracted: string[] = [];
  const failed: string[] = [];
  const claimedTargets = new Set<string>();

  for (const f of readdirSync(resolvedArchivesDir).sort((a, b) => a.localeCompare(b, "en"))) {
    if (!ARCHIVE_RE.test(f)) continue;
    const archivePath = join(resolvedArchivesDir, f);
    const slug = slugify(f.replace(ARCHIVE_RE, "")) || "archive";
    const target = join(resolvedExtractedDir, slug);
    if (claimedTargets.has(target)) {
      failed.push(f);
      continue;
    }
    claimedTargets.add(target);
    assertWithin(target, [resolvedExtractedDir]);
    const markerPath = join(target, ".asset-fetch-source.json");
    const sourceStat = statSync(archivePath);
    let markerMatches = false;
    try {
      const marker = JSON.parse(readFileSync(markerPath, "utf8")) as {
        size?: unknown;
        mtimeMs?: unknown;
      };
      markerMatches = marker.size === sourceStat.size && marker.mtimeMs === sourceStat.mtimeMs;
    } catch {
      markerMatches = false;
    }
    if (markerMatches) {
      continue;
    }

    const staging = mkdtempSync(join(resolvedExtractedDir, `.asset-fetch-${slug}-`));
    try {
      if (/\.zip$/i.test(f)) {
        const listing = spawnSync("unzip", ["-Z1", archivePath], { encoding: "utf8" });
        if (listing.status !== 0) throw new Error(`unzip could not list ${f}`);
        assertSafeArchiveEntries(spawnOutputText(listing.stdout).split(/\r?\n/).filter(Boolean));
        const result = spawnSync("unzip", ["-q", "-o", archivePath, "-d", staging], {
          stdio: "inherit",
        });
        if (result.status !== 0) throw new Error(`unzip failed for ${f}`);
      } else if (/\.rar$/i.test(f)) {
        const { createExtractorFromFile } = await import("node-unrar-js");
        const extractor = await createExtractorFromFile({
          filepath: archivePath,
          targetPath: staging,
        });
        const rarEntries: string[] = [];
        for (const header of extractor.getFileList().fileHeaders) rarEntries.push(header.name);
        assertSafeArchiveEntries(rarEntries);
        const { files } = extractor.extract();
        for (const _ of files) {
          // iterating the generator triggers extraction as a side effect
        }
      } else {
        const listing = spawnSync("7z", ["l", "-slt", "--", archivePath], { encoding: "utf8" });
        if (listing.status !== 0) throw new Error(`7z could not list ${f}`);
        const stdout = spawnOutputText(listing.stdout);
        const divider = stdout.indexOf("----------");
        const entryText = divider >= 0 ? stdout.slice(divider) : "";
        const entries = [...entryText.matchAll(/^Path = (.+)$/gm)].map((match) => String(match[1]));
        assertSafeArchiveEntries(entries);
        const result = spawnSync("7z", ["x", `-o${staging}`, "-y", "--", archivePath], {
          stdio: "inherit",
        });
        if (result.status !== 0) throw new Error(`7z failed for ${f}`);
      }
      // Entry names were checked lexically above, but a symlink member passes
      // that check and can point anywhere. Audit what the extractor really
      // wrote, and discard the whole extraction (the catch below) if any entry
      // resolves outside the staging directory.
      assertExtractionContained(staging);
      writeFileSync(
        join(staging, ".asset-fetch-source.json"),
        `${JSON.stringify({ size: sourceStat.size, mtimeMs: sourceStat.mtimeMs })}\n`
      );
      rmSync(target, { recursive: true, force: true });
      renameSync(staging, target);
      extracted.push(slug);
    } catch {
      failed.push(f);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }
  return { extracted, failed };
}

function assertSafeArchiveEntries(entries: string[]): void {
  for (const entry of entries) {
    const portable = entry.replaceAll("\\", "/");
    const parts = portable.split("/");
    if (
      portable.startsWith("/") ||
      /^[a-z]:\//i.test(portable) ||
      parts.some((part) => part === "..")
    ) {
      throw new Error(`unsafe archive entry: ${entry}`);
    }
  }
}
