import { mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { downloadHttpsFile } from "./http.js";
import { fileMatches, requireHttpsUrl } from "./integrity.js";
import { assertWithin } from "./safety.js";

export type PolyhavenAssetType = "hdris" | "textures" | "models";

export interface PolyhavenAsset {
  id: string;
  name: string;
  description: string;
  type: PolyhavenAssetType;
  category: string | null;
  tags: string[];
  thumbnailUrl: string | null;
  downloadCount: number;
  sourceUrl: string;
  license: "CC0-1.0";
}

export interface SearchPolyhavenOptions {
  type?: PolyhavenAssetType | "all";
  maxResults?: number;
  fetchImpl?: typeof fetch;
}

export interface PolyhavenFile {
  key: string;
  relativePath: string;
  url: string;
  size: number;
  md5: string;
}

export interface ListPolyhavenFilesOptions {
  fetchImpl?: typeof fetch;
}

export interface FetchPolyhavenAssetOptions extends ListPolyhavenFilesOptions {
  assetId: string;
  targetDir: string;
  resolution?: string;
  format?: string;
  downloadImpl?: (url: string, destination: string) => Promise<void>;
}

export interface FetchPolyhavenAssetResult {
  directory: string;
  downloaded: string[];
  skipped: string[];
}

const API_ORIGIN = "https://api.polyhaven.com";
const TYPE_BY_ID: Record<number, PolyhavenAssetType | undefined> = {
  0: "hdris",
  1: "textures",
  2: "models",
};
const SAFE_ASSET_ID_RE = /^[a-z0-9_-]+$/i;
const ALLOWED_DOWNLOAD_HOSTS = new Set(["dl.polyhaven.org", "dl.polyhaven.com"]);

function positiveResultLimit(value: number | undefined): number {
  const limit = value ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("maxResults must be an integer between 1 and 100");
  }
  return limit;
}

async function getJson(url: string, fetchImpl: typeof fetch): Promise<unknown> {
  const response = await fetchImpl(url, {
    headers: { Accept: "application/json", "User-Agent": "asset-fetch" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok)
    throw new Error(`Poly Haven API failed: HTTP ${response.status} ${response.statusText}`);
  try {
    return await response.json();
  } catch (error) {
    throw new Error(`Poly Haven API returned invalid JSON: ${(error as Error).message}`);
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function mapAsset(id: string, value: unknown): PolyhavenAsset | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const row = value as Record<string, unknown>;
  const type = typeof row.type === "number" ? TYPE_BY_ID[row.type] : undefined;
  if (!type || typeof row.name !== "string") return undefined;
  return {
    id,
    name: row.name,
    description: typeof row.description === "string" ? row.description : "",
    type,
    category: typeof row.category === "string" ? row.category : null,
    tags: stringList(row.tags),
    thumbnailUrl: typeof row.thumbnail_url === "string" ? row.thumbnail_url : null,
    downloadCount: typeof row.download_count === "number" ? row.download_count : 0,
    sourceUrl: `https://polyhaven.com/a/${encodeURIComponent(id)}`,
    license: "CC0-1.0",
  };
}

function relevance(asset: PolyhavenAsset, terms: string[]): number {
  const id = asset.id.toLowerCase();
  const name = asset.name.toLowerCase();
  const haystack =
    `${name} ${asset.description} ${asset.category ?? ""} ${asset.tags.join(" ")}`.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (id === term || name === term) score += 100;
    else if (id.startsWith(term) || name.startsWith(term)) score += 25;
    else if (haystack.includes(term)) score += 5;
  }
  return score;
}

/** Search Poly Haven's current asset metadata endpoint client-side. */
export async function searchPolyhaven(
  query: string,
  options: SearchPolyhavenOptions = {}
): Promise<PolyhavenAsset[]> {
  const maxResults = positiveResultLimit(options.maxResults);
  const type = options.type ?? "all";
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = new URL("/assets", API_ORIGIN);
  url.searchParams.set("type", type);
  const payload = await getJson(url.href, fetchImpl);
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("Poly Haven API returned an invalid asset collection");
  }
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return Object.entries(payload)
    .map(([id, value]) => mapAsset(id, value))
    .filter((asset): asset is PolyhavenAsset => asset !== undefined)
    .map((asset) => ({ asset, score: relevance(asset, terms) }))
    .filter(({ score }) => terms.length === 0 || score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.asset.downloadCount - a.asset.downloadCount ||
        a.asset.name.localeCompare(b.asset.name)
    )
    .slice(0, maxResults)
    .map(({ asset }) => asset);
}

function collectFiles(
  value: unknown,
  path: string[],
  output: PolyhavenFile[],
  includePath?: string
): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return;
  const node = value as Record<string, unknown>;
  if (
    typeof node.url === "string" &&
    typeof node.size === "number" &&
    typeof node.md5 === "string"
  ) {
    const url = requireHttpsUrl(node.url, "Poly Haven download URL");
    if (!ALLOWED_DOWNLOAD_HOSTS.has(url.hostname)) {
      throw new Error(`Poly Haven download URL uses an unexpected host: ${url.hostname}`);
    }
    output.push({
      key: path.join("/"),
      relativePath: includePath ?? basename(decodeURIComponent(url.pathname)),
      url: url.href,
      size: node.size,
      md5: node.md5,
    });
  }
  for (const [key, child] of Object.entries(node)) {
    if (key === "include" && typeof child === "object" && child !== null && !Array.isArray(child)) {
      for (const [relativePath, included] of Object.entries(child)) {
        collectFiles(included, [...path, "include", relativePath], output, relativePath);
      }
    } else if (!["url", "size", "md5"].includes(key)) {
      collectFiles(child, [...path, key], output, includePath);
    }
  }
}

/** Flatten the `/files/{id}` response into stable, selectable file descriptors. */
export async function listPolyhavenFiles(
  assetId: string,
  options: ListPolyhavenFilesOptions = {}
): Promise<PolyhavenFile[]> {
  if (!SAFE_ASSET_ID_RE.test(assetId))
    throw new Error("assetId may contain only letters, numbers, _ or -");
  const payload = await getJson(
    `${API_ORIGIN}/files/${encodeURIComponent(assetId)}`,
    options.fetchImpl ?? fetch
  );
  const files: PolyhavenFile[] = [];
  collectFiles(payload, [], files);
  if (files.length === 0)
    throw new Error(`Poly Haven returned no downloadable files for ${assetId}`);
  return files;
}

function safeRelativePath(value: string): string {
  const portable = value.replaceAll("\\", "/");
  const parts = portable.split("/").filter((part) => part && part !== ".");
  if (
    portable.startsWith("/") ||
    /^[a-z]:\//i.test(portable) ||
    parts.some((part) => part === "..")
  ) {
    throw new Error(`unsafe Poly Haven include path: ${value}`);
  }
  return parts.join("/");
}

async function defaultDownload(urlValue: string, destination: string): Promise<void> {
  await downloadHttpsFile(urlValue, destination, {
    allowedHosts: ALLOWED_DOWNLOAD_HOSTS,
    headers: { "User-Agent": "asset-fetch" },
    label: "Poly Haven download URL",
  });
}

/** Download one format/resolution variant plus any required include files. */
export async function fetchPolyhavenAsset(
  options: FetchPolyhavenAssetOptions
): Promise<FetchPolyhavenAssetResult> {
  const resolution = options.resolution ?? "1k";
  const format = options.format ?? "gltf";
  if (!/^[a-z0-9_-]+$/i.test(resolution)) throw new Error("resolution is invalid");
  if (!/^[a-z0-9_-]+$/i.test(format)) throw new Error("format is invalid");
  const files = await listPolyhavenFiles(options.assetId, options);
  const main = files.find((file) => {
    const parts = file.key.split("/");
    return !parts.includes("include") && parts.at(-2) === resolution && parts.at(-1) === format;
  });
  if (!main) {
    const variants = files
      .filter((file) => !file.key.includes("/include/"))
      .map((file) => file.key)
      .sort((a, b) => a.localeCompare(b, "en"));
    throw new Error(
      `Poly Haven has no ${resolution}/${format} variant for ${options.assetId}. Available: ${variants.join(", ")}`
    );
  }
  const selected = [main, ...files.filter((file) => file.key.startsWith(`${main.key}/include/`))];
  const directory = resolve(options.targetDir, options.assetId);
  assertWithin(directory, [options.targetDir]);
  const destinations = new Set<string>();
  const plan = selected.map((file) => {
    const relative = safeRelativePath(file.relativePath);
    if (!relative) throw new Error(`Poly Haven returned an empty path for ${file.key}`);
    const portableIdentity = relative.toLowerCase();
    if (destinations.has(portableIdentity))
      throw new Error(`Poly Haven variant contains duplicate path: ${relative}`);
    destinations.add(portableIdentity);
    const destination = join(directory, relative);
    assertWithin(destination, [directory]);
    return { file, destination };
  });
  const checked = plan.map((entry) => ({
    ...entry,
    matches: fileMatches(entry.destination, entry.file),
  }));
  const skipped = checked.filter(({ matches }) => matches).map(({ destination }) => destination);
  const pending = checked.filter(({ matches }) => !matches);
  if (pending.length === 0) {
    return { directory, downloaded: [], skipped };
  }

  const targetRoot = resolve(options.targetDir);
  mkdirSync(targetRoot, { recursive: true });
  const staging = mkdtempSync(join(targetRoot, `.asset-fetch-${options.assetId}-`));
  try {
    for (const { file } of pending) {
      const relative = safeRelativePath(file.relativePath);
      const staged = join(staging, relative);
      mkdirSync(dirname(staged), { recursive: true });
      await (options.downloadImpl ?? defaultDownload)(file.url, staged);
      if (!fileMatches(staged, file)) {
        throw new Error(`Downloaded file failed size or MD5 verification: ${file.key}`);
      }
    }
    // Revalidate the complete plan after network waits, before committing any file.
    for (const { destination } of pending) assertWithin(destination, [options.targetDir]);
    for (const { file, destination } of pending) {
      mkdirSync(dirname(destination), { recursive: true });
      renameSync(join(staging, safeRelativePath(file.relativePath)), destination);
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  const downloaded = pending.map(({ destination }) => destination);
  return { directory, downloaded, skipped };
}
