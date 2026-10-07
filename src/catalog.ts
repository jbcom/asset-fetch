import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface CatalogAsset {
  path: string;
  name: string;
  style: string | null;
  category: string | null;
  pack: string | null;
  source: string | null;
  meshes: number | null;
  vertices: number | null;
  faces: number | null;
  materials: number | null;
  textures: number | null;
  hasEmbeddedTextures: boolean;
  hasArmature: boolean;
  animations: number;
  extensions: string[];
  fileSizeKb: number | null;
  previewPath: string | null;
  tags: string[];
}

export interface SearchCatalogOptions {
  databasePath?: string;
  assetsRoot?: string;
  style?: string;
  category?: string;
  hasArmature?: boolean;
  hasTextures?: boolean;
  maxResults?: number;
}

export type CatalogUnavailableReason = "assets-root-missing" | "catalog-missing" | "catalog-error";

interface SearchCatalogBase {
  databasePath: string;
}

export interface AvailableCatalogResult extends SearchCatalogBase {
  available: true;
  assets: CatalogAsset[];
}

export interface UnavailableCatalogResult extends SearchCatalogBase {
  available: false;
  assets: [];
  unavailableReason: CatalogUnavailableReason;
  message: string;
}

export type SearchCatalogResult = AvailableCatalogResult | UnavailableCatalogResult;

// The catalog is written by game-asset-mcp, which keeps it at this fixed
// path under the user's home directory (it does not consult XDG_DATA_HOME),
// so this reads the same file that tool writes when nothing is configured.
const DEFAULT_DATABASE_PATH = join(homedir(), ".local", "share", "game-asset-mcp", "catalog.db");

/**
 * Resolve the directory the catalog indexes: the explicit option, else
 * `ASSET_FETCH_ASSETS_ROOT`. There is deliberately no default, because any
 * default would name a path that exists on only one machine.
 *
 * @throws when neither is set (a blank value counts as unset).
 */
export function resolveAssetsRoot(explicit?: string): string {
  const configured = explicit?.trim() || process.env.ASSET_FETCH_ASSETS_ROOT?.trim();
  if (!configured) {
    throw new Error(
      "Asset root is not configured: pass the assetsRoot option or set ASSET_FETCH_ASSETS_ROOT to the directory the catalog indexes"
    );
  }
  return resolve(configured);
}

function ftsQuery(query: string): string {
  return query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => `"${term.replaceAll('"', '""')}"*`)
    .join(" AND ");
}

function stringArray(value: unknown, separator: RegExp): string[] {
  if (typeof value !== "string" || !value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) return parsed;
  } catch {
    // Tags are stored as plain space-separated text; extensions are JSON.
  }
  return value
    .split(separator)
    .map((part) => part.trim())
    .filter(Boolean);
}

function mapCatalogAsset(value: unknown): CatalogAsset {
  const row = value as Record<string, unknown>;
  const nullableString = (key: string): string | null =>
    typeof row[key] === "string" ? row[key] : null;
  const nullableNumber = (key: string): number | null =>
    typeof row[key] === "number" ? row[key] : null;
  return {
    path: String(row.path),
    name: String(row.name),
    style: nullableString("style"),
    category: nullableString("category"),
    pack: nullableString("pack"),
    source: nullableString("source"),
    meshes: nullableNumber("meshes"),
    vertices: nullableNumber("vertices"),
    faces: nullableNumber("faces"),
    materials: nullableNumber("materials"),
    textures: nullableNumber("textures"),
    hasEmbeddedTextures: row.has_embedded_textures === 1,
    hasArmature: row.has_armature === 1,
    animations: nullableNumber("animations") ?? 0,
    extensions: stringArray(row.extensions, /\s+/),
    fileSizeKb: nullableNumber("file_size_kb"),
    previewPath: nullableString("preview_path"),
    tags: stringArray(row.tags, /\s+/),
  };
}

/**
 * Search the read-only SQLite catalog produced by game-asset-mcp. A missing
 * mount or catalog is a normal environmental state, so it returns an empty,
 * structured result instead of throwing. Invalid caller options remain
 * programmer errors and do throw, and so does an asset root that was never
 * configured (see {@link resolveAssetsRoot}).
 */
export function searchCatalog(query = "", options: SearchCatalogOptions = {}): SearchCatalogResult {
  const maxResults = options.maxResults ?? 20;
  if (!Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > 100) {
    throw new Error("maxResults must be an integer between 1 and 100");
  }

  const databasePath = resolve(
    options.databasePath ??
      process.env.ASSET_FETCH_CATALOG_DB ??
      process.env.CATALOG_DB ??
      DEFAULT_DATABASE_PATH
  );
  const assetsRoot = resolveAssetsRoot(options.assetsRoot);
  if (!existsSync(assetsRoot)) {
    return {
      assets: [],
      databasePath,
      available: false,
      unavailableReason: "assets-root-missing",
      message: `Asset root is not mounted or does not exist: ${assetsRoot}`,
    };
  }
  if (!existsSync(databasePath)) {
    return {
      assets: [],
      databasePath,
      available: false,
      unavailableReason: "catalog-missing",
      message: `Asset catalog does not exist: ${databasePath}`,
    };
  }

  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true, timeout: 1_000 });
    const clauses: string[] = [];
    const parameters: Array<string | number> = [];
    const search = ftsQuery(query);
    let sql = search
      ? "SELECT a.* FROM assets_fts f JOIN assets a ON a.id = f.rowid"
      : "SELECT a.* FROM assets a";
    if (search) {
      clauses.push("assets_fts MATCH ?");
      parameters.push(search);
    }
    if (options.style) {
      clauses.push("a.style = ?");
      parameters.push(options.style);
    }
    if (options.category) {
      clauses.push("a.category LIKE ? ESCAPE '\\'");
      parameters.push(
        `%${options.category.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`
      );
    }
    if (options.hasArmature !== undefined) {
      clauses.push("a.has_armature = ?");
      parameters.push(options.hasArmature ? 1 : 0);
    }
    if (options.hasTextures !== undefined) {
      clauses.push("(COALESCE(a.textures, 0) > 0) = ?");
      parameters.push(options.hasTextures ? 1 : 0);
    }
    if (clauses.length > 0) sql += ` WHERE ${clauses.join(" AND ")}`;
    sql += search ? " ORDER BY rank" : " ORDER BY a.name COLLATE NOCASE";
    sql += " LIMIT ?";
    parameters.push(maxResults);
    const rows = database.prepare(sql).all(...parameters);
    return { assets: rows.map(mapCatalogAsset), databasePath, available: true };
  } catch (error) {
    return {
      assets: [],
      databasePath,
      available: false,
      unavailableReason: "catalog-error",
      message: `Asset catalog could not be read: ${(error as Error).message}`,
    };
  } finally {
    database?.close();
  }
}
