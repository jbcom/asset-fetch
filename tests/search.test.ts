import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, test, vi } from "vitest";
import type { OwnedPack } from "../src/library.js";
import { findAssets } from "../src/search.js";

const itchLibrary: OwnedPack[] = [
  {
    keyId: 1,
    gameId: 10,
    title: "Forest Sound Pack",
    classification: "asset",
    shortText: "Wind and bird audio",
    url: "https://author.itch.io/forest-sound",
  },
  {
    keyId: 2,
    gameId: 20,
    title: "Forest Tiles",
    classification: "asset",
    shortText: "Pixel RPG tileset",
    url: "",
  },
];

describe("findAssets", () => {
  test("searches and maps the owned itch library", async () => {
    const result = await findAssets("forest", { sources: ["itch"], itchLibrary });
    expect(result.warnings).toEqual([]);
    expect(result.results).toEqual([
      {
        source: "itch",
        id: "10",
        name: "Forest Sound Pack",
        description: "Wind and bird audio",
        kind: "audio",
        url: "https://author.itch.io/forest-sound",
      },
      {
        source: "itch",
        id: "20",
        name: "Forest Tiles",
        description: "Pixel RPG tileset",
        kind: "2d",
      },
    ]);
  });

  test("filters by unified kind and warns when an itch cache is absent", async () => {
    expect(
      (await findAssets("forest", { sources: ["itch"], itchLibrary, kind: "2d" })).results
    ).toHaveLength(1);
    expect((await findAssets("", { sources: ["itch"] })).warnings).toEqual([
      "itch: no owned-library cache was provided",
    ]);
  });

  test("maps 3D itch packs and exercises exact, contained, and unmatched query terms", async () => {
    const threeDimensional: OwnedPack = {
      keyId: 3,
      gameId: 30,
      title: "PSX Dungeon Models",
      classification: "asset",
      shortText: "Low-poly GLB kit",
      url: "",
    };
    expect(
      (await findAssets("PSX", { sources: ["itch"], itchLibrary: [threeDimensional] })).results[0]
        ?.kind
    ).toBe("3d");

    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          exact: { name: "Tree", description: "plain", type: 2 },
          contained: { name: "Old Tree", description: "deep forest", type: 2 },
        })
      )) as unknown as typeof fetch;
    const ranked = await findAssets("absent tree", {
      sources: ["polyhaven"],
      polyhaven: { fetchImpl },
    });
    expect(ranked.results[0]?.name).toBe("Tree");
    const contained = await findAssets("forest tree", {
      sources: ["polyhaven"],
      polyhaven: { fetchImpl },
    });
    expect(contained.results.map(({ name }) => name)).toContain("Old Tree");
  });

  test("maps Poly Haven results and converts failures into partial-result warnings", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          tree: {
            name: "Tree",
            description: "A model tree",
            type: 2,
            thumbnail_url: "https://cdn.polyhaven.com/tree.webp",
          },
        })
      )) as unknown as typeof fetch;
    const result = await findAssets("tree", {
      sources: ["polyhaven"],
      kind: "3d",
      polyhaven: { fetchImpl },
    });
    expect(result.results[0]).toMatchObject({
      source: "polyhaven",
      id: "tree",
      kind: "3d",
      previewUrl: "https://cdn.polyhaven.com/tree.webp",
    });

    const failed = await findAssets("tree", {
      sources: ["polyhaven"],
      polyhaven: {
        fetchImpl: (async () => new Response("no", { status: 500 })) as typeof fetch,
      },
    });
    expect(failed.results).toEqual([]);
    expect(failed.warnings[0]).toContain("polyhaven: Poly Haven API failed");
  });

  test("does not call irrelevant Poly Haven types", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const result = await findAssets("sound", {
      sources: ["polyhaven"],
      kind: "audio",
      polyhaven: { fetchImpl },
    });
    expect(result).toEqual({ results: [], warnings: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("reports a missing asset root without failing other sources", async () => {
    const result = await findAssets("forest", {
      sources: ["itch", "catalog"],
      itchLibrary,
      catalog: { assetsRoot: "/definitely/not/mounted", databasePath: "/missing/catalog.db" },
    });
    expect(result.results).toHaveLength(2);
    expect(result.warnings[0]).toContain("catalog: Asset root is not mounted");
  });

  test("reports an unconfigured asset root as a warning, not a failure", async () => {
    vi.stubEnv("ASSET_FETCH_ASSETS_ROOT", undefined);
    try {
      const result = await findAssets("forest", { sources: ["itch", "catalog"], itchLibrary });
      expect(result.results).toHaveLength(2);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toMatch(/^catalog: Asset root is not configured/);
      expect(result.warnings[0]).toContain("ASSET_FETCH_ASSETS_ROOT");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("maps available catalog rows and applies unified kind filtering", async () => {
    const root = mkdtempSync(join(tmpdir(), "asset-fetch-unified-catalog-"));
    const databasePath = join(root, "catalog.db");
    try {
      const database = new DatabaseSync(databasePath);
      database.exec(`
        CREATE TABLE assets (
          id INTEGER PRIMARY KEY, path TEXT, name TEXT, style TEXT, category TEXT,
          pack TEXT, source TEXT, meshes INTEGER, vertices INTEGER, faces INTEGER,
          materials INTEGER, textures INTEGER, has_embedded_textures INTEGER,
          has_armature INTEGER, animations INTEGER, extensions TEXT,
          file_size_kb INTEGER, preview_path TEXT, tags TEXT
        );
        CREATE VIRTUAL TABLE assets_fts USING fts5(
          name, category, pack, source, tags, style, content=assets, content_rowid=id
        );
        INSERT INTO assets VALUES (
          1, '/assets/tree.glb', 'Pine Tree', 'Low Poly', 'Nature', 'Forest',
          'Local', 1, 10, 8, 1, 1, 1, 0, 0, '[]', 20, '/preview/tree.png', 'pine tree'
        );
        INSERT INTO assets_fts(assets_fts) VALUES('rebuild');
      `);
      database.close();

      const result = await findAssets("pine", {
        sources: ["catalog"],
        catalog: { databasePath, assetsRoot: root },
      });
      expect(result.results).toEqual([
        {
          source: "catalog",
          id: "/assets/tree.glb",
          name: "Pine Tree",
          description: "Low Poly · Nature · Forest",
          kind: "3d",
          path: "/assets/tree.glb",
          previewUrl: "/preview/tree.png",
        },
      ]);
      const update = new DatabaseSync(databasePath);
      update.exec("UPDATE assets SET preview_path = NULL WHERE id = 1");
      update.close();
      expect(
        (
          await findAssets("pine", {
            sources: ["catalog"],
            catalog: { databasePath, assetsRoot: root },
          })
        ).results[0]?.previewUrl
      ).toBeUndefined();
      expect(
        (
          await findAssets("pine", {
            sources: ["catalog"],
            kind: "audio",
            catalog: { databasePath, assetsRoot: root },
          })
        ).results
      ).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("maps every Poly Haven kind and preserves stable source order on blank queries", async () => {
    const result = await findAssets("", {
      sources: ["polyhaven"],
      polyhaven: {
        fetchImpl: (async () =>
          new Response(
            JSON.stringify({
              model: { name: "Model", type: 2, download_count: 3 },
              hdri: { name: "HDRI", type: 0, download_count: 2 },
              texture: { name: "Texture", type: 1, download_count: 1 },
            })
          )) as unknown as typeof fetch,
      },
    });
    expect(result.results.map(({ kind }) => kind)).toEqual(["3d", "hdri", "texture"]);
    expect(result.results.every((row) => row.previewUrl === undefined)).toBe(true);

    const hdriResponse = (async () =>
      new Response(
        JSON.stringify({ asset: { name: "Asset", type: 0 } })
      )) as unknown as typeof fetch;
    const textureResponse = (async () =>
      new Response(
        JSON.stringify({ asset: { name: "Asset", type: 1 } })
      )) as unknown as typeof fetch;
    expect(
      (
        await findAssets("asset", {
          sources: ["polyhaven"],
          kind: "hdri",
          polyhaven: { fetchImpl: hdriResponse },
        })
      ).results[0]?.kind
    ).toBe("hdri");
    expect(
      (
        await findAssets("asset", {
          sources: ["polyhaven"],
          kind: "texture",
          polyhaven: { fetchImpl: textureResponse },
        })
      ).results[0]?.kind
    ).toBe("texture");
  });

  test("uses all backends by default", async () => {
    const result = await findAssets("nothing", {
      kind: "audio",
      itchLibrary: [],
      catalog: { assetsRoot: "/definitely/not/mounted" },
    });
    expect(result.results).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test("validates limits and duplicate source selections", async () => {
    await expect(findAssets("", { maxResults: 0 })).rejects.toThrow(/between 1 and 100/);
    await expect(findAssets("", { sources: ["catalog", "catalog"] })).rejects.toThrow(/duplicates/);
  });
});
