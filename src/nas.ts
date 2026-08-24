import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface NasAsset {
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

export interface SearchNasCatalogOptions {
  databasePath?: string;
  assetsRoot?: string;
  style?: string;
  category?: string;
  hasArmature?: boolean;
  hasTextures?: boolean;
  maxResults?: number;
}

export type NasUnavailableReason = "assets-root-missing" | "catalog-missing" | "catalog-error";

interface SearchNasCatalogBase {
  databasePath: string;
}

export interface AvailableNasCatalogResult extends SearchNasCatalogBase {
  available: true;
  assets: NasAsset[];
}

export interface UnavailableNasCatalogResult extends SearchNasCatalogBase {
  available: false;
  assets: [];
  unavailableReason: NasUnavailableReason;
  message: string;
}

export type SearchNasCatalogResult = AvailableNasCatalogResult | UnavailableNasCatalogResult;

const DEFAULT_DATABASE_PATH = join(homedir(), ".local", "share", "assets-mcp", "catalog.db");
const DEFAULT_ASSETS_ROOT = "/path/to/assets";

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

function mapNasAsset(value: unknown): NasAsset {
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
 * Search the read-only SQLite catalog produced by assets-mcp. Missing mounts
 * and catalogs are normal environmental states, so they return an empty,
 * structured result instead of throwing. Invalid caller options remain
 * programmer errors and do throw.
 */
export function searchNasCatalog(
  query = "",
  options: SearchNasCatalogOptions = {}
): SearchNasCatalogResult {
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
  const assetsRoot = resolve(
    options.assetsRoot ?? process.env.ASSET_FETCH_ASSETS_ROOT ?? DEFAULT_ASSETS_ROOT
  );
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
      clauses.push("a.has_embedded_textures = ?");
      parameters.push(options.hasTextures ? 1 : 0);
    }
    if (clauses.length > 0) sql += ` WHERE ${clauses.join(" AND ")}`;
    sql += search ? " ORDER BY rank" : " ORDER BY a.name COLLATE NOCASE";
    sql += " LIMIT ?";
    parameters.push(maxResults);
    const rows = database.prepare(sql).all(...parameters);
    return { assets: rows.map(mapNasAsset), databasePath, available: true };
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
