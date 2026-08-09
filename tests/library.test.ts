import { describe, expect, test } from "vitest";
import {
  classifyPack,
  dedupeByGame,
  fetchOwnedLibrary,
  sanitizeItchUrl,
  type OwnedPack,
} from "../src/library.js";

describe("sanitizeItchUrl", () => {
  test("passes through well-formed https URLs", () => {
    expect(sanitizeItchUrl("https://author.itch.io/game")).toBe("https://author.itch.io/game");
  });

  test("strips malformed self-referential URLs", () => {
    expect(sanitizeItchUrl("https://author.itch.io/httpsauthoritchio")).toBe("");
  });

  test("rejects non-string and non-http(s) values", () => {
    expect(sanitizeItchUrl(undefined)).toBe("");
    expect(sanitizeItchUrl(42)).toBe("");
    expect(sanitizeItchUrl("ftp://example.com")).toBe("");
  });
});

describe("classifyPack", () => {
  const base: OwnedPack = {
    keyId: 1,
    gameId: 1,
    title: "",
    classification: "asset",
    shortText: "",
    url: "",
  };

  test("classifies audio packs from title text", () => {
    expect(classifyPack({ ...base, title: "UI Sound Effects Pack" })).toBe("audio");
  });

  test("classifies pixel-art packs", () => {
    expect(classifyPack({ ...base, title: "16x16 Top-Down Tileset" })).toBe("pixel-2d");
  });

  test("classifies 3d/voxel packs", () => {
    expect(classifyPack({ ...base, title: "Low Poly Voxel Models" })).toBe("3d-psx");
  });

  test("falls back to tool classification field", () => {
    expect(classifyPack({ ...base, title: "Random Utility", classification: "tool" })).toBe(
      "tool"
    );
  });

  test("falls back to other", () => {
    expect(classifyPack({ ...base, title: "Something Unrelated" })).toBe("other");
  });
});

describe("dedupeByGame", () => {
  test("keeps first-seen entry per gameId", () => {
    const packs: OwnedPack[] = [
      { keyId: 1, gameId: 100, title: "A", classification: "", shortText: "", url: "" },
      { keyId: 2, gameId: 100, title: "A (dup key)", classification: "", shortText: "", url: "" },
      { keyId: 3, gameId: 200, title: "B", classification: "", shortText: "", url: "" },
    ];
    const deduped = dedupeByGame(packs);
    expect(deduped).toHaveLength(2);
    expect(deduped[0]?.title).toBe("A");
  });
});

function fakeResponse(init: {
  ok?: boolean;
  status?: number;
  statusText?: string;
  json?: unknown;
  retryAfter?: string;
}): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: init.statusText ?? "",
    json: async () => init.json,
    headers: { get: (name: string) => (name === "retry-after" ? (init.retryAfter ?? null) : null) },
  } as unknown as Response;
}

describe("fetchOwnedLibrary", () => {
  test("paginates until an empty page, then stops", async () => {
    let calls = 0;
    const fetchImpl = (async (url: string) => {
      calls++;
      const page = new URL(url).searchParams.get("page");
      const body =
        page === "1"
          ? { owned_keys: [{ id: 1, game: { id: 10, title: "Pack One" } }] }
          : { owned_keys: [] };
      return fakeResponse({ json: body });
    }) as unknown as typeof fetch;

    const packs = await fetchOwnedLibrary({ apiKey: "key", fetchImpl });
    expect(packs).toHaveLength(1);
    expect(packs[0]?.title).toBe("Pack One");
    expect(calls).toBe(2);
  });

  test("throws with the HTTP status on a failed page", async () => {
    const fetchImpl = (async () =>
      fakeResponse({ ok: false, status: 500, statusText: "Internal Server Error" })) as unknown as typeof fetch;
    await expect(fetchOwnedLibrary({ apiKey: "key", fetchImpl })).rejects.toThrow(/500/);
  });

  test("retries on 429 and succeeds once the server recovers", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls === 1) return fakeResponse({ ok: false, status: 429, retryAfter: "0" });
      return fakeResponse({ json: { owned_keys: [] } });
    }) as unknown as typeof fetch;

    const sleeps: number[] = [];
    const packs = await fetchOwnedLibrary({
      apiKey: "key",
      fetchImpl,
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(packs).toEqual([]);
    expect(calls).toBe(2);
    expect(sleeps).toEqual([0]);
  });

  test("gives up after the retry budget and surfaces the 429", async () => {
    const fetchImpl = (async () =>
      fakeResponse({ ok: false, status: 429, statusText: "Too Many Requests" })) as unknown as typeof fetch;

    await expect(
      fetchOwnedLibrary({ apiKey: "key", fetchImpl, sleepImpl: async () => {} })
    ).rejects.toThrow(/429/);
  });
});
