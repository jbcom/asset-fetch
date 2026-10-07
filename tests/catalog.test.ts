import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { resolveAssetsRoot, searchCatalog } from "../src/catalog.js";

describe("searchCatalog", () => {
  let root: string;
  let assetsRoot: string;
  let databasePath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "asset-fetch-catalog-"));
    assetsRoot = join(root, "assets");
    databasePath = join(root, "catalog.db");
    mkdirSync(assetsRoot);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  function createCatalog(): void {
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE assets (
        id INTEGER PRIMARY KEY,
        path TEXT NOT NULL,
        name TEXT NOT NULL,
        style TEXT,
        category TEXT,
        pack TEXT,
        source TEXT,
        meshes INTEGER,
        vertices INTEGER,
        faces INTEGER,
        materials INTEGER,
        textures INTEGER,
        has_embedded_textures INTEGER,
        has_armature INTEGER,
        animations INTEGER,
        extensions TEXT,
        file_size_kb INTEGER,
        preview_path TEXT,
        tags TEXT
      );
      CREATE VIRTUAL TABLE assets_fts USING fts5(
        name, category, pack, source, tags, style, content=assets, content_rowid=id
      );
      INSERT INTO assets VALUES (
        1, '/assets/tree.glb', 'Pine Tree', '3DLowPoly', 'Environment/Nature',
        'Forest Pack', 'Kenney', 2, 120, 80, 1, 1, 1, 0, NULL,
        '["KHR_materials_unlit"]', 42, '/previews/tree.png', 'tree pine low-poly'
      );
      INSERT INTO assets VALUES (
        2, '/assets/knight.glb', 'Knight', '3DPSX', 'Characters/Animated',
        'Dungeon Pack', 'Custom', NULL, NULL, NULL, NULL, NULL, 0, 1, 3,
        'not-json', NULL, NULL, 'knight armored'
      );
      INSERT INTO assets_fts(assets_fts) VALUES('rebuild');
    `);
    database.close();
  }

  test("fails soft when the assets root is unavailable", () => {
    const result = searchCatalog("tree", {
      databasePath,
      assetsRoot: join(root, "missing-assets"),
    });
    expect(result).toMatchObject({
      available: false,
      unavailableReason: "assets-root-missing",
      assets: [],
      message: expect.stringContaining("not mounted"),
    });
  });

  test("fails soft when the catalog is missing or unreadable", () => {
    expect(searchCatalog("", { databasePath, assetsRoot })).toMatchObject({
      available: false,
      unavailableReason: "catalog-missing",
    });

    writeFileSync(databasePath, "not sqlite");
    expect(searchCatalog("", { databasePath, assetsRoot })).toMatchObject({
      available: false,
      unavailableReason: "catalog-error",
    });
  });

  test("searches FTS safely and maps catalog rows into the public type", () => {
    createCatalog();
    const result = searchCatalog('pine "tree"', {
      databasePath,
      assetsRoot,
      style: "3DLowPoly",
      category: "Environment",
      hasArmature: false,
      hasTextures: true,
      maxResults: 5,
    });

    expect(result.available).toBe(true);
    expect(result.assets).toEqual([
      {
        path: "/assets/tree.glb",
        name: "Pine Tree",
        style: "3DLowPoly",
        category: "Environment/Nature",
        pack: "Forest Pack",
        source: "Kenney",
        meshes: 2,
        vertices: 120,
        faces: 80,
        materials: 1,
        textures: 1,
        hasEmbeddedTextures: true,
        hasArmature: false,
        animations: 0,
        extensions: ["KHR_materials_unlit"],
        fileSizeKb: 42,
        previewPath: "/previews/tree.png",
        tags: ["tree", "pine", "low-poly"],
      },
    ]);
  });

  test("supports filter-only search and null/default fields", () => {
    createCatalog();
    const result = searchCatalog("", {
      databasePath,
      assetsRoot,
      hasArmature: true,
      hasTextures: false,
    });
    expect(result.assets[0]).toMatchObject({
      name: "Knight",
      meshes: null,
      animations: 3,
      extensions: ["not-json"],
      fileSizeKb: null,
      previewPath: null,
    });

    const database = new DatabaseSync(databasePath);
    database.exec("UPDATE assets SET extensions = NULL, tags = NULL WHERE id = 2");
    database.close();
    expect(searchCatalog("", { databasePath, assetsRoot }).assets[0]).toMatchObject({
      name: "Knight",
      extensions: [],
      tags: [],
    });
  });

  test("resolves explicit environment overrides and the compatibility fallback", () => {
    createCatalog();
    vi.stubEnv("ASSET_FETCH_CATALOG_DB", databasePath);
    vi.stubEnv("ASSET_FETCH_ASSETS_ROOT", assetsRoot);
    expect(searchCatalog("pine", { maxResults: 1 }).assets).toHaveLength(1);

    vi.stubEnv("ASSET_FETCH_CATALOG_DB", undefined);
    vi.stubEnv("CATALOG_DB", databasePath);
    expect(
      searchCatalog("pine", { databasePath: undefined, assetsRoot, maxResults: 1 }).available
    ).toBe(true);
  });

  test("defaults the catalog to the path game-asset-mcp writes", () => {
    vi.stubEnv("ASSET_FETCH_CATALOG_DB", undefined);
    vi.stubEnv("CATALOG_DB", undefined);
    const result = searchCatalog("", { assetsRoot });
    expect(result.databasePath).toBe(
      join(homedir(), ".local", "share", "game-asset-mcp", "catalog.db")
    );
  });

  test("an explicit root wins over the environment", () => {
    createCatalog();
    vi.stubEnv("ASSET_FETCH_ASSETS_ROOT", join(root, "elsewhere"));
    expect(searchCatalog("pine", { databasePath, assetsRoot }).available).toBe(true);
  });

  describe("asset root is required", () => {
    test("throws a clear error when neither an option nor the environment sets it", () => {
      vi.stubEnv("ASSET_FETCH_ASSETS_ROOT", undefined);
      expect(() => searchCatalog("tree", { databasePath })).toThrow(
        /ASSET_FETCH_ASSETS_ROOT.*assetsRoot|assetsRoot.*ASSET_FETCH_ASSETS_ROOT/
      );
    });

    test("treats a blank environment value as unset", () => {
      vi.stubEnv("ASSET_FETCH_ASSETS_ROOT", "   ");
      expect(() => searchCatalog("tree", { databasePath })).toThrow(/not configured/);
      expect(() => resolveAssetsRoot("")).toThrow(/not configured/);
    });

    test("resolves an option or the environment to an absolute path", () => {
      expect(resolveAssetsRoot(assetsRoot)).toBe(resolve(assetsRoot));
      vi.stubEnv("ASSET_FETCH_ASSETS_ROOT", assetsRoot);
      expect(resolveAssetsRoot()).toBe(resolve(assetsRoot));
    });
  });

  test.each([0, 101, 1.5])("rejects invalid maxResults values (%s)", (maxResults) => {
    expect(() => searchCatalog("", { databasePath, assetsRoot, maxResults })).toThrow(
      /between 1 and 100/
    );
  });
});
