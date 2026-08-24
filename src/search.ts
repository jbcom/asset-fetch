import { classifyPack, type OwnedPack, searchLibrary } from "./library.js";
import { type SearchNasCatalogOptions, searchNasCatalog } from "./nas.js";
import {
  type PolyhavenAssetType,
  type SearchPolyhavenOptions,
  searchPolyhaven,
} from "./polyhaven.js";

export type AssetSource = "itch" | "nas" | "polyhaven";
export type AssetKind = "audio" | "2d" | "3d" | "hdri" | "texture" | "tool" | "other";

export interface UnifiedAssetResult {
  source: AssetSource;
  id: string;
  name: string;
  description: string;
  kind: AssetKind;
  url?: string;
  path?: string;
  previewUrl?: string;
}

export interface FindAssetsOptions {
  sources?: AssetSource[];
  kind?: AssetKind;
  maxResults?: number;
  itchLibrary?: OwnedPack[];
  nas?: SearchNasCatalogOptions;
  polyhaven?: SearchPolyhavenOptions;
}

export interface FindAssetsResult {
  results: UnifiedAssetResult[];
  warnings: string[];
}

function limitValue(value: number | undefined): number {
  const limit = value ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("maxResults must be an integer between 1 and 100");
  }
  return limit;
}

function itchKind(pack: OwnedPack): AssetKind {
  const bucket = classifyPack(pack);
  if (bucket === "pixel-2d") return "2d";
  if (bucket === "3d-psx") return "3d";
  return bucket;
}

function polyhavenType(kind: AssetKind | undefined): PolyhavenAssetType | "all" | undefined {
  if (kind === "3d") return "models";
  if (kind === "hdri") return "hdris";
  if (kind === "texture") return "textures";
  if (kind === undefined) return "all";
  return undefined;
}

function queryScore(result: UnifiedAssetResult, query: string): number {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const name = result.name.toLowerCase();
  const haystack = `${name} ${result.description}`.toLowerCase();
  return terms.reduce((score, term) => {
    if (name === term) return score + 100;
    if (name.startsWith(term)) return score + 25;
    if (haystack.includes(term)) return score + 5;
    return score;
  }, 0);
}

/** Fan out one query across the selected concrete backends and merge results. */
export async function findAssets(
  query: string,
  options: FindAssetsOptions = {}
): Promise<FindAssetsResult> {
  const maxResults = limitValue(options.maxResults);
  const sources = options.sources ?? ["itch", "nas", "polyhaven"];
  if (new Set(sources).size !== sources.length)
    throw new Error("sources must not contain duplicates");
  const warnings: string[] = [];
  const ranked: Array<{ result: UnifiedAssetResult; score: number; order: number }> = [];
  let order = 0;

  if (sources.includes("itch")) {
    if (!options.itchLibrary) {
      warnings.push("itch: no owned-library cache was provided");
    } else {
      const packs = searchLibrary(options.itchLibrary, { query });
      for (const pack of packs) {
        const kind = itchKind(pack);
        if (options.kind && kind !== options.kind) continue;
        const result: UnifiedAssetResult = {
          source: "itch",
          id: String(pack.gameId),
          name: pack.title,
          description: pack.shortText,
          kind,
          ...(pack.url ? { url: pack.url } : {}),
        };
        ranked.push({ result, score: queryScore(result, query), order: order++ });
      }
    }
  }

  if (sources.includes("nas") && (options.kind === undefined || options.kind === "3d")) {
    const nas = searchNasCatalog(query, { ...options.nas, maxResults });
    if (!nas.available) {
      warnings.push(`nas: ${nas.message}`);
    } else {
      for (const asset of nas.assets) {
        const result: UnifiedAssetResult = {
          source: "nas",
          id: asset.path,
          name: asset.name,
          description: [asset.style, asset.category, asset.pack].filter(Boolean).join(" · "),
          kind: "3d",
          path: asset.path,
          ...(asset.previewPath ? { previewUrl: asset.previewPath } : {}),
        };
        ranked.push({ result, score: queryScore(result, query), order: order++ });
      }
    }
  }

  if (sources.includes("polyhaven")) {
    const type = polyhavenType(options.kind);
    if (type) {
      try {
        const assets = await searchPolyhaven(query, { ...options.polyhaven, type, maxResults });
        for (const asset of assets) {
          const kind: AssetKind =
            asset.type === "models" ? "3d" : asset.type === "hdris" ? "hdri" : "texture";
          const result: UnifiedAssetResult = {
            source: "polyhaven",
            id: asset.id,
            name: asset.name,
            description: asset.description,
            kind,
            url: asset.sourceUrl,
            ...(asset.thumbnailUrl ? { previewUrl: asset.thumbnailUrl } : {}),
          };
          ranked.push({ result, score: queryScore(result, query), order: order++ });
        }
      } catch (error) {
        warnings.push(`polyhaven: ${(error as Error).message}`);
      }
    }
  }

  ranked.sort((a, b) => b.score - a.score || a.order - b.order);
  return { results: ranked.slice(0, maxResults).map(({ result }) => result), warnings };
}
