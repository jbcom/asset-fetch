import { copyFileSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { spawnSync } from "node:child_process";

export interface PromoteSlot {
  /** Destination filename stem, e.g. "ambient-pad" — becomes
   * "<targetDir>/ambient-pad-0.ogg", "-1.ogg", etc. for multi-file slots. */
  name: string;
  /** Source file(s) — absolute paths, already selected by the caller from
   * the raw extracted tree. One slot can bundle several source files
   * (e.g. round-robin variation samples for one sound cue). */
  sources: string[];
}

/** Options for {@link promoteAssets}. */
export interface PromoteOptions {
  /** The slot -> source-file(s) mapping to promote. */
  slots: PromoteSlot[];
  /** Destination directory the slot files are copied into (e.g. a game's
   * `public/assets/audio`). Created if missing when `apply` is true. */
  targetDir: string;
  /** Copies only when true; otherwise reports what WOULD be copied. */
  apply?: boolean;
  /** Run ffmpeg's loudnorm filter (-16 LUFS target) on each promoted file.
   * Requires ffmpeg on PATH. If ffmpeg is missing or exits non-zero, this
   * does NOT throw — it silently leaves the plain (non-normalized) copy in
   * place, so a missing ffmpeg degrades gracefully rather than failing the
   * whole promote run. */
  normalize?: boolean;
}

/** Result of one {@link promoteAssets} call. */
export interface PromoteResult {
  /** slot name -> destination paths written (or that would be written). */
  written: Record<string, string[]>;
  /** Same information as `written`, reshaped for {@link writeAssetManifest}
   * — one entry per slot, filenames only (no directory component). */
  manifest: AssetManifestEntry[];
}

/** One slot's entry in the `manifest.json` written by
 * {@link writeAssetManifest} — what a game's audio-loading code reads back
 * to resolve a slot name to its promoted file(s). */
export interface AssetManifestEntry {
  /** Slot name, matching {@link PromoteSlot.name}. */
  slot: string;
  /** Promoted filenames for this slot (basenames only, e.g. `"bark-0.wav"`),
   * in the same order as the slot's `sources`. */
  files: string[];
  /** Number of source files this slot was built from — lets consuming code
   * distinguish a single-file cue from a round-robin variation set without
   * re-deriving it from `files.length`. */
  sourceCount: number;
}

/**
 * Copy curated slot files from wherever fetchItchAssets/extractArchives put
 * them into a game's public asset directory, optionally loudness-normalizing
 * via ffmpeg. Idempotent (re-running overwrites the slot's files, never
 * appends a growing pile) and dry-run by default — the caller decides when
 * `apply: true` actually touches disk, following the convention of a
 * safety-first promote step separate from the bulk itch fetch.
 */
export function promoteAssets(options: PromoteOptions): PromoteResult {
  const { slots, targetDir, apply = false, normalize = false } = options;
  if (apply) mkdirSync(targetDir, { recursive: true });

  const written: Record<string, string[]> = {};
  const manifest: AssetManifestEntry[] = [];

  for (const slot of slots) {
    const destPaths: string[] = [];
    slot.sources.forEach((src, i) => {
      const ext = extname(src) || ".ogg";
      const destName = slot.sources.length > 1 ? `${slot.name}-${i}${ext}` : `${slot.name}${ext}`;
      const dest = join(targetDir, destName);
      destPaths.push(dest);
      if (!apply) return;

      copyFileSync(src, dest);
      if (normalize) {
        const normalized = `${dest}.norm${ext}`;
        const result = spawnSync(
          "ffmpeg",
          ["-y", "-i", dest, "-af", "loudnorm=I=-16:TP=-1.5:LRA=11", normalized],
          { stdio: "ignore" }
        );
        if (result.status === 0) {
          copyFileSync(normalized, dest);
          spawnSync("rm", ["-f", normalized]);
        }
      }
    });
    written[slot.name] = destPaths;
    manifest.push({
      slot: slot.name,
      // dest is always built via join(targetDir, destName), so split("/").pop()
      // can never actually return undefined here — the ?? p fallback exists only
      // to satisfy TypeScript's Array#pop() signature (T | undefined), not because
      // this path is reachable at runtime.
      /* v8 ignore next */
      files: destPaths.map((p) => p.split("/").pop() ?? p),
      sourceCount: slot.sources.length,
    });
  }

  return { written, manifest };
}

/** Write a `manifest.json` next to the promoted files — the consuming
 * game's own audio-loading code (e.g. @jbcom/gesture-audio's sprite
 * resolver) reads this to build its sprite map, rather than hardcoding
 * filenames in game source. The written file is `{ generatedAt, slots }`,
 * where `generatedAt` is the current time as an ISO 8601 string (useful
 * for a consuming game to tell a stale manifest from a freshly-promoted
 * one) and `slots` is `manifest` as given. */
export function writeAssetManifest(targetDir: string, manifest: AssetManifestEntry[]): void {
  const path = join(targetDir, "manifest.json");
  const generatedAt = new Date().toISOString();
  writeFileSync(path, `${JSON.stringify({ generatedAt, slots: manifest }, null, 2)}\n`);
}

/** Recursively list every audio file under a directory — the raw-extracted
 * tree from extractArchives, so callers can build PromoteSlot.sources by
 * filtering this list rather than hand-walking the filesystem themselves. */
export function listExtractedAudioFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) walk(full);
      else if (/\.(wav|mp3|ogg|flac)$/i.test(entry)) out.push(full);
    }
  };
  walk(dir);
  return out;
}
