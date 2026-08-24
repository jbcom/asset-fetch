import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";

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
  /** Directory loose (non-archive) audio/image files are written to, one
   * subdirectory per pack slug. Created if missing. */
  looseDir: string;
  /** List what would be downloaded without writing anything. */
  dry?: boolean;
  /** Injected for tests. */
  apiGetImpl?: (path: string) => Promise<unknown>;
  /** Injected for tests — replaces the real backoff delay between apiGet retries. */
  retrySleepImpl?: (ms: number) => Promise<void>;
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
  /** Absolute paths of every archive (`.zip`/`.rar`/`.7z`) that is now
   * present in `archivesDir` — downloaded this run or already skipped as
   * up to date — ready to hand to {@link extractArchives}. */
  archives: string[];
}

const ARCHIVE_RE = /\.(zip|rar|7z)$/i;
const LOOSE_RE = /\.(wav|mp3|ogg|flac)$/i;

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

async function defaultApiGet(apiKey: string, path: string): Promise<unknown> {
  const result = spawnSync(
    "curl",
    ["-sS", "-fL", "-H", `Authorization: Bearer ${apiKey}`, `https://itch.io${path}`],
    { encoding: "utf8" }
  );
  if (result.status !== 0) {
    throw new Error(`apiGet failed (exit ${result.status}): ${path}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`apiGet: non-JSON response for ${path}`);
  }
}

const API_MAX_RETRIES = 3;

/**
 * A transient curl failure (exit 56 "failure receiving network data" and
 * similar) on itch.io's API is common enough in practice — confirmed while
 * building this package: a batch download died on the second pack from a
 * one-off network blip that succeeded on manual retry seconds later. Wrap
 * every apiGet call with a short retry instead of letting one flaky
 * request abort an entire multi-pack batch; callers that want the
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
 * Download every upload for the given owned packs into archivesDir/looseDir.
 * TOCTOU-safe idempotency: reads the existing destination file ONCE and
 * compares size+md5 rather than checking existence then re-reading — a
 * missing file just throws ENOENT, caught below, and falls through to
 * download. Every download is forced through https with --proto pinning on
 * both the initial request and every redirect hop; filenames are
 * basename()-stripped so a malicious upload.filename can't zip-slip outside
 * the target directory.
 */
export async function fetchItchAssets(options: FetchAssetsOptions): Promise<FetchAssetsResult> {
  const { apiKey, packs, archivesDir, looseDir, dry = false } = options;
  const rawApiGet = options.apiGetImpl ?? ((path: string) => defaultApiGet(apiKey, path));
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
    const uploads = archiveUploads.length > 0 ? archiveUploads : all.filter((u) => LOOSE_RE.test(u.filename ?? ""));

    if (uploads.length === 0) {
      failed++;
      continue;
    }

    for (const upload of uploads) {
      const isArchive = ARCHIVE_RE.test(upload.filename);
      const packSlug = slugify(pack.title);
      const safeName = basename(upload.filename);
      const dest = isArchive
        ? join(archivesDir, `${packSlug}__${safeName}`)
        : join(looseDir, packSlug, safeName);

      try {
        const existing = readFileSync(dest);
        if (
          existing.length === upload.size &&
          (!upload.md5_hash ||
            createHash("md5").update(existing).digest("hex") === upload.md5_hash)
        ) {
          skipped++;
          if (isArchive) archives.push(dest);
          continue;
        }
      } catch {
        // not present — fall through to download.
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
      if (!dlInfo?.url || !dlInfo.url.startsWith("https://")) {
        failed++;
        continue;
      }

      if (!isArchive) mkdirSync(join(looseDir, packSlug), { recursive: true });

      const result = spawnSync(
        "curl",
        [
          "-sS",
          "-fL",
          "--proto",
          "=https",
          "--proto-redir",
          "=https",
          "-o",
          dest,
          dlInfo.url,
        ],
        { stdio: "inherit" }
      );
      if (result.status !== 0 || statSync(dest).size !== upload.size) {
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
 * the system `unzip`; .rar via node-unrar-js (bone-buster's pattern — the
 * only prior variant handling non-zip archives); .7z via the system `7z`
 * if present. Skips archives already extracted at least as recently as
 * their source archive's mtime.
 */
export async function extractArchives(
  archivesDir: string,
  extractedDir: string
): Promise<{ extracted: string[]; failed: string[] }> {
  mkdirSync(extractedDir, { recursive: true });
  const extracted: string[] = [];
  const failed: string[] = [];

  for (const f of readdirSync(archivesDir)) {
    if (!ARCHIVE_RE.test(f)) continue;
    const archivePath = join(archivesDir, f);
    const slug = slugify(f.replace(ARCHIVE_RE, ""));
    const target = join(extractedDir, slug);
    if (existsSync(target) && statSync(target).mtimeMs >= statSync(archivePath).mtimeMs) {
      continue;
    }
    mkdirSync(target, { recursive: true });
    try {
      if (/\.zip$/i.test(f)) {
        spawnSync("unzip", ["-q", "-o", archivePath, "-d", target], { stdio: "inherit" });
      } else if (/\.rar$/i.test(f)) {
        const { createExtractorFromFile } = await import("node-unrar-js");
        const extractor = await createExtractorFromFile({
          filepath: archivePath,
          targetPath: target,
        });
        const { files } = extractor.extract();
        for (const _ of files) {
          // iterating the generator triggers extraction as a side effect
        }
      } else {
        spawnSync("7z", ["x", `-o${target}`, "-y", archivePath], { stdio: "inherit" });
      }
      extracted.push(slug);
    } catch {
      failed.push(f);
    }
  }
  return { extracted, failed };
}
