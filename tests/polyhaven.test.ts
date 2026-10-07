import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fetchPolyhavenAsset, listPolyhavenFiles, searchPolyhaven } from "../src/polyhaven.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function md5(value: string): string {
  return createHash("md5").update(value).digest("hex");
}

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

interface FixtureFile {
  url: string;
  size: number;
  md5: string;
}

function variantFixture(main = "gltf", included = "texture", withInclude = true) {
  const include: Record<string, FixtureFile> | undefined = withInclude
    ? {
        "textures/diffuse.jpg": {
          url: "https://dl.polyhaven.org/diffuse.jpg",
          size: included.length,
          md5: md5(included),
        },
      }
    : undefined;
  // `include` is always present on the fixture so tests can replace entries
  // in place; an empty map and a missing one mean the same thing to the code.
  return {
    gltf: {
      "1k": {
        gltf: {
          url: "https://dl.polyhaven.org/model.gltf",
          size: main.length,
          md5: md5(main),
          include: include ?? {},
        },
      },
    },
    blend: {
      "2k": {
        blend: {
          url: "https://dl.polyhaven.org/model.blend",
          size: 5,
          md5: md5("blend"),
        },
      },
    },
  };
}

describe("searchPolyhaven", () => {
  test("maps, ranks, filters, and limits current API metadata", async () => {
    let requested = "";
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      requested = String(url);
      return jsonResponse({
        exact_tree: {
          name: "Exact Tree",
          description: "A pine tree",
          type: 2,
          category: "Nature/Trees",
          tags: ["pine", 42],
          thumbnail_url: "https://cdn.polyhaven.com/tree.webp",
          download_count: 10,
        },
        popular: {
          name: "Forest Pine",
          description: "tree in a forest",
          type: 2,
          download_count: 100,
        },
        malformed: { name: "No type" },
        primitive: "bad",
      });
    }) as unknown as typeof fetch;

    const result = await searchPolyhaven("exact tree", {
      type: "models",
      maxResults: 2,
      fetchImpl,
    });
    expect(new URL(requested).searchParams.get("type")).toBe("models");
    expect(result.map((asset) => asset.id)).toEqual(["exact_tree", "popular"]);
    expect(result[0]).toMatchObject({
      type: "models",
      category: "Nature/Trees",
      tags: ["pine"],
      thumbnailUrl: "https://cdn.polyhaven.com/tree.webp",
      license: "CC0-1.0",
      sourceUrl: "https://polyhaven.com/a/exact_tree",
    });
  });

  test("returns popular assets for a blank query and supplies metadata defaults", async () => {
    const fetchImpl = (async () =>
      jsonResponse({
        texture: { name: "Texture", type: 1, download_count: 2 },
        hdri: { name: "HDRI", type: 0, download_count: 5 },
      })) as unknown as typeof fetch;
    const result = await searchPolyhaven("  ", { fetchImpl });
    expect(result.map((asset) => asset.id)).toEqual(["hdri", "texture"]);
    expect(result[0]).toMatchObject({
      description: "",
      category: null,
      tags: [],
      thumbnailUrl: null,
    });
  });

  test("uses names as a deterministic final sort key", async () => {
    const fetchImpl = (async () =>
      jsonResponse({
        zed: { name: "Zed Tree", description: "tree", type: 2, download_count: 1 },
        alpha: { name: "Alpha Tree", description: "tree", type: 2, download_count: 1 },
      })) as unknown as typeof fetch;
    expect((await searchPolyhaven("tree", { fetchImpl })).map(({ id }) => id)).toEqual([
      "alpha",
      "zed",
    ]);
  });

  test("uses the global fetch implementation by default", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ asset: { name: "Asset", type: 1 } }))
    );
    await expect(searchPolyhaven("asset")).resolves.toMatchObject([{ id: "asset" }]);
  });

  test.each([0, 101, 1.2])("rejects an invalid result limit (%s)", async (maxResults) => {
    await expect(searchPolyhaven("", { maxResults })).rejects.toThrow(/between 1 and 100/);
  });

  test("reports HTTP, JSON, and collection-shape errors", async () => {
    await expect(
      searchPolyhaven("", {
        fetchImpl: (async () =>
          new Response("no", { status: 503, statusText: "Unavailable" })) as typeof fetch,
      })
    ).rejects.toThrow(/503/);
    await expect(
      searchPolyhaven("", {
        fetchImpl: (async () => new Response("not-json")) as typeof fetch,
      })
    ).rejects.toThrow(/invalid JSON/);
    await expect(
      searchPolyhaven("", { fetchImpl: (async () => jsonResponse([])) as unknown as typeof fetch })
    ).rejects.toThrow(/invalid asset collection/);
  });
});

describe("Poly Haven file discovery and fetch", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "asset-fetch-polyhaven-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  test("flattens main and included files", async () => {
    const files = await listPolyhavenFiles("ceramic_vase_03", {
      fetchImpl: (async () => jsonResponse(variantFixture())) as unknown as typeof fetch,
    });
    expect(files.map((file) => ({ key: file.key, relativePath: file.relativePath }))).toEqual([
      { key: "gltf/1k/gltf", relativePath: "model.gltf" },
      {
        key: "gltf/1k/gltf/include/textures/diffuse.jpg",
        relativePath: "textures/diffuse.jpg",
      },
      { key: "blend/2k/blend", relativePath: "model.blend" },
    ]);
  });

  test("validates asset ids, file hosts, and empty file responses", async () => {
    await expect(listPolyhavenFiles("../escape")).rejects.toThrow(/assetId/);
    await expect(
      listPolyhavenFiles("safe", {
        fetchImpl: (async () =>
          jsonResponse({
            file: { url: "https://evil.example/file", size: 1, md5: md5("x") },
          })) as unknown as typeof fetch,
      })
    ).rejects.toThrow(/unexpected host/);
    await expect(
      listPolyhavenFiles("safe", {
        fetchImpl: (async () => jsonResponse({ metadata: true })) as unknown as typeof fetch,
      })
    ).rejects.toThrow(/no downloadable files/);
  });

  test("uses global fetch for file discovery and rejects an empty destination path", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(variantFixture()))
    );
    await expect(listPolyhavenFiles("asset")).resolves.toHaveLength(3);

    await expect(
      fetchPolyhavenAsset({
        assetId: "asset",
        targetDir: root,
        fetchImpl: (async () =>
          jsonResponse({
            gltf: {
              "1k": {
                gltf: { url: "https://dl.polyhaven.org/", size: 1, md5: md5("x") },
              },
            },
          })) as unknown as typeof fetch,
      })
    ).rejects.toThrow(/empty path/);
  });

  test("downloads a selected variant and its includes, then skips verified files", async () => {
    const fetchImpl = (async () => jsonResponse(variantFixture())) as unknown as typeof fetch;
    const downloadImpl = async (url: string, destination: string) => {
      writeFileSync(destination, url.endsWith("model.gltf") ? "gltf" : "texture");
    };
    const options = {
      assetId: "ceramic_vase_03",
      targetDir: root,
      fetchImpl,
      downloadImpl,
    };
    const first = await fetchPolyhavenAsset(options);
    expect(first.downloaded).toHaveLength(2);
    expect(readFileSync(join(first.directory, "model.gltf"), "utf8")).toBe("gltf");
    expect(readFileSync(join(first.directory, "textures", "diffuse.jpg"), "utf8")).toBe("texture");
    const second = await fetchPolyhavenAsset(options);
    expect(second.downloaded).toEqual([]);
    expect(second.skipped).toHaveLength(2);
  });

  test("cleans temporary files after checksum failure", async () => {
    await expect(
      fetchPolyhavenAsset({
        assetId: "asset",
        targetDir: root,
        fetchImpl: (async () => jsonResponse(variantFixture())) as unknown as typeof fetch,
        downloadImpl: async (_url, destination) => writeFileSync(destination, "wrong"),
      })
    ).rejects.toThrow(/verification/);
    const directory = join(root, "asset");
    expect(existsSync(directory)).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });

  test("does not commit earlier files when a later include download fails", async () => {
    let downloads = 0;
    await expect(
      fetchPolyhavenAsset({
        assetId: "asset",
        targetDir: root,
        fetchImpl: (async () => jsonResponse(variantFixture())) as unknown as typeof fetch,
        downloadImpl: async (url, destination) => {
          downloads++;
          if (url.endsWith("diffuse.jpg")) throw new Error("network stopped");
          writeFileSync(destination, "gltf");
        },
      })
    ).rejects.toThrow(/network stopped/);
    expect(downloads).toBe(2);
    expect(existsSync(join(root, "asset"))).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });

  test("reports missing variants and validates format selectors", async () => {
    const fetchImpl = (async () => jsonResponse(variantFixture())) as unknown as typeof fetch;
    await expect(
      fetchPolyhavenAsset({ assetId: "asset", targetDir: root, resolution: "8k", fetchImpl })
    ).rejects.toThrow(/Available: blend\/2k\/blend, gltf\/1k\/gltf/);
    await expect(
      fetchPolyhavenAsset({ assetId: "asset", targetDir: root, resolution: "../", fetchImpl })
    ).rejects.toThrow(/resolution is invalid/);
    await expect(
      fetchPolyhavenAsset({ assetId: "asset", targetDir: root, format: "../", fetchImpl })
    ).rejects.toThrow(/format is invalid/);
  });

  test("rejects unsafe and duplicate include destinations", async () => {
    const unsafe = variantFixture();
    unsafe.gltf["1k"].gltf.include = {
      "../escape.jpg": unsafe.gltf["1k"].gltf.include["textures/diffuse.jpg"],
    };
    await expect(
      fetchPolyhavenAsset({
        assetId: "asset",
        targetDir: root,
        fetchImpl: (async () => jsonResponse(unsafe)) as unknown as typeof fetch,
        downloadImpl: async () => {},
      })
    ).rejects.toThrow(/unsafe/);

    const duplicate = variantFixture();
    duplicate.gltf["1k"].gltf.include = {
      "model.gltf": duplicate.gltf["1k"].gltf.include["textures/diffuse.jpg"],
    };
    await expect(
      fetchPolyhavenAsset({
        assetId: "asset",
        targetDir: root,
        fetchImpl: (async () => jsonResponse(duplicate)) as unknown as typeof fetch,
        downloadImpl: async (url, destination) =>
          writeFileSync(destination, url.endsWith("model.gltf") ? "gltf" : "texture"),
      })
    ).rejects.toThrow(/duplicate path/);

    const caseDuplicate = variantFixture();
    caseDuplicate.gltf["1k"].gltf.include = {
      "MODEL.GLTF": caseDuplicate.gltf["1k"].gltf.include["textures/diffuse.jpg"],
    };
    await expect(
      fetchPolyhavenAsset({
        assetId: "asset",
        targetDir: root,
        fetchImpl: (async () => jsonResponse(caseDuplicate)) as unknown as typeof fetch,
      })
    ).rejects.toThrow(/duplicate path/);
  });

  test("the built-in downloader follows safe redirects and streams the response", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        if (calls === 1) {
          return new Response(null, {
            status: 302,
            headers: { location: "https://dl.polyhaven.org/final-model" },
          });
        }
        return new Response("gltf");
      })
    );

    const minimal = variantFixture("gltf", "texture", false);
    const result = await fetchPolyhavenAsset({
      assetId: "asset",
      targetDir: root,
      fetchImpl: (async () => jsonResponse(minimal)) as unknown as typeof fetch,
    });
    expect(result.downloaded).toHaveLength(1);
    expect(calls).toBe(2);
    const downloaded = result.downloaded.at(0);
    expect(downloaded).toBeDefined();
    if (!downloaded) throw new Error("expected a downloaded file");
    expect(readFileSync(downloaded, "utf8")).toBe("gltf");
  });
});
