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

export interface PromoteOptions {
  slots: PromoteSlot[];
  targetDir: string;
  /** Copies only when true; otherwise reports what WOULD be copied. */
  apply?: boolean;
  /** Run ffmpeg's loudnorm filter (-16 LUFS target) on each promoted file.
   * Requires ffmpeg on PATH; throws if apply is true and ffmpeg is missing. */
  normalize?: boolean;
}

export interface PromoteResult {
  /** slot name -> destination paths written (or that would be written). */
  written: Record<string, string[]>;
  manifest: AssetManifestEntry[];
}

export interface AssetManifestEntry {
  slot: string;
  files: string[];
  sourceCount: number;
}

/**
 * Copy curated slot files from wherever fetchItchAssets/extractArchives put
 * them into a game's public asset directory, optionally loudness-normalizing
 * via ffmpeg. Idempotent (re-running overwrites the slot's files, never
 * appends a growing pile) and dry-run by default — the caller decides when
 * `apply: true` actually touches disk, matching the fleet convention of a
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
    manifest.push({ slot: slot.name, files: destPaths.map((p) => p.split("/").pop() ?? p), sourceCount: slot.sources.length });
  }

  return { written, manifest };
}

/** Write a `manifest.json` next to the promoted files — the consuming
 * game's own audio-loading code (e.g. @jbcom/gesture-audio's sprite
 * resolver) reads this to build its sprite map, rather than hardcoding
 * filenames in game source. */
export function writeAssetManifest(targetDir: string, manifest: AssetManifestEntry[]): void {
  const path = join(targetDir, "manifest.json");
  writeFileSync(path, `${JSON.stringify({ generatedAt: null, slots: manifest }, null, 2)}\n`);
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
