import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, join } from "node:path";

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

const AUDIO_EXT_RE = /^\.(wav|mp3|ogg|flac)$/i;
const SAFE_SLOT_RE = /^[a-z0-9][a-z0-9_-]*$/i;

interface PlannedFile {
  source: string;
  destinationName: string;
  destinationPath: string;
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
  const written: Record<string, string[]> = {};
  const manifest: AssetManifestEntry[] = [];
  const planned: PlannedFile[] = [];
  const slotNames = new Set<string>();
  const destinationNames = new Map<string, string>();

  for (const slot of slots) {
    if (!SAFE_SLOT_RE.test(slot.name)) {
      throw new Error(
        `invalid slot name ${JSON.stringify(slot.name)}: use letters, numbers, _ or -`
      );
    }
    const slotIdentity = slot.name.toLowerCase();
    if (slotNames.has(slotIdentity)) throw new Error(`duplicate slot name: ${slot.name}`);
    if (slot.sources.length === 0) throw new Error(`slot ${slot.name} has no source files`);
    slotNames.add(slotIdentity);

    const destPaths: string[] = [];
    slot.sources.forEach((src, i) => {
      const sourceExtension = extname(src);
      if (sourceExtension && !AUDIO_EXT_RE.test(sourceExtension)) {
        throw new Error(`unsupported audio extension for ${src}: ${sourceExtension}`);
      }
      const ext = (sourceExtension || ".ogg").toLowerCase();
      const destName = slot.sources.length > 1 ? `${slot.name}-${i}${ext}` : `${slot.name}${ext}`;
      const dest = join(targetDir, destName);
      const destinationIdentity = destName.toLowerCase();
      const existingOwner = destinationNames.get(destinationIdentity);
      if (existingOwner) {
        throw new Error(`slots ${existingOwner} and ${slot.name} both produce ${destName}`);
      }
      destinationNames.set(destinationIdentity, slot.name);
      destPaths.push(dest);
      planned.push({ source: src, destinationName: destName, destinationPath: dest });
    });
    written[slot.name] = destPaths;
    manifest.push({
      slot: slot.name,
      files: destPaths.map((p) => basename(p)),
      sourceCount: slot.sources.length,
    });
  }

  if (!apply) return { written, manifest };

  mkdirSync(targetDir, { recursive: true });
  const staging = mkdtempSync(join(targetDir, ".asset-fetch-promote-"));
  try {
    for (const file of planned) {
      const staged = join(staging, file.destinationName);
      copyFileSync(file.source, staged);
      if (!normalize) continue;

      const ext = extname(staged);
      const normalized = `${staged}.norm${ext}`;
      try {
        const result = spawnSync(
          "ffmpeg",
          ["-y", "-i", staged, "-af", "loudnorm=I=-16:TP=-1.5:LRA=11", normalized],
          { stdio: "ignore" }
        );
        if (result.status === 0) copyFileSync(normalized, staged);
      } finally {
        rmSync(normalized, { force: true });
      }
    }

    const namesInTarget = readdirSync(targetDir);
    for (const slotName of slotNames) {
      const escaped = slotName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const stalePattern = new RegExp(`^${escaped}(?:-\\d+)?\\.(?:wav|mp3|ogg|flac)$`, "i");
      for (const name of namesInTarget) {
        if (stalePattern.test(name) && !destinationNames.has(name.toLowerCase())) {
          rmSync(join(targetDir, name), { force: true });
        }
      }
    }

    for (const file of planned) {
      renameSync(join(staging, file.destinationName), file.destinationPath);
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }

  return { written, manifest };
}

/** Write a `manifest.json` next to the promoted files — the consuming
 * game's own audio-loading code (e.g. @jbdevprimary/gesture-audio's sprite
 * resolver) reads this to build its sprite map, rather than hardcoding
 * filenames in game source. The written file is `{ generatedAt, slots }`,
 * where `generatedAt` is the current time as an ISO 8601 string (useful
 * for a consuming game to tell a stale manifest from a freshly-promoted
 * one) and `slots` is `manifest` as given. */
export function writeAssetManifest(targetDir: string, manifest: AssetManifestEntry[]): void {
  mkdirSync(targetDir, { recursive: true });
  const temporaryDir = mkdtempSync(join(targetDir, ".asset-fetch-manifest-"));
  const temporaryPath = join(temporaryDir, "manifest.json");
  const path = join(targetDir, "manifest.json");
  const generatedAt = new Date().toISOString();
  try {
    writeFileSync(temporaryPath, `${JSON.stringify({ generatedAt, slots: manifest }, null, 2)}\n`);
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryDir, { recursive: true, force: true });
  }
}

/** Recursively list every audio file under a directory — the raw-extracted
 * tree from extractArchives, so callers can build PromoteSlot.sources by
 * filtering this list rather than hand-walking the filesystem themselves. */
export function listExtractedAudioFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    const entries = readdirSync(d, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    );
    for (const entry of entries) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && AUDIO_EXT_RE.test(extname(entry.name))) out.push(full);
    }
  };
  walk(dir);
  return out;
}
