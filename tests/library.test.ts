import { describe, expect, test, vi } from "vitest";
import {
  classifyPack,
  dedupeByGame,
  fetchOwnedLibrary,
  type OwnedPack,
  sanitizeItchUrl,
  searchLibrary,
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
    expect(classifyPack({ ...base, title: "Random Utility", classification: "tool" })).toBe("tool");
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
      fakeResponse({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      })) as unknown as typeof fetch;
    await expect(fetchOwnedLibrary({ apiKey: "key", fetchImpl })).rejects.toThrow(/500/);
  });

  test("falls back to the global fetch when no fetchImpl is injected", async () => {
    // options.fetchImpl ?? fetch — stub the global fetch itself so the
    // default-fetch branch runs without hitting the real network.
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return fakeResponse({ json: { owned_keys: [] } });
    }) as unknown as typeof fetch;

    try {
      const packs = await fetchOwnedLibrary({ apiKey: "key" });
      expect(packs).toEqual([]);
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("treats a non-array owned_keys field as an empty page and stops", async () => {
    const fetchImpl = (async () =>
      fakeResponse({ json: { owned_keys: "not-an-array" } })) as unknown as typeof fetch;
    const packs = await fetchOwnedLibrary({ apiKey: "key", fetchImpl });
    expect(packs).toEqual([]);
  });

  test("rejects an owned key that omits its game instead of violating the OwnedPack type", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      const body = calls === 1 ? { owned_keys: [{ id: 1 }] } : { owned_keys: [] };
      return fakeResponse({ json: body });
    }) as unknown as typeof fetch;

    await expect(fetchOwnedLibrary({ apiKey: "key", fetchImpl })).rejects.toThrow(/no game object/);
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

  test("supports an HTTP-date Retry-After value", async () => {
    let calls = 0;
    const retryAt = new Date(Date.now() + 5_000).toUTCString();
    const sleeps: number[] = [];
    const fetchImpl = (async () => {
      calls++;
      return calls === 1
        ? fakeResponse({ ok: false, status: 429, retryAfter: retryAt })
        : fakeResponse({ json: { owned_keys: [] } });
    }) as unknown as typeof fetch;

    await fetchOwnedLibrary({ apiKey: "key", fetchImpl, sleepImpl: async (ms) => sleeps.push(ms) });
    expect(sleeps[0]).toBeGreaterThanOrEqual(3_500);
    expect(sleeps[0]).toBeLessThanOrEqual(5_000);
  });

  test("falls back to exponential backoff for invalid or negative Retry-After values", async () => {
    for (const retryAfter of ["not-a-date", "-1"]) {
      let calls = 0;
      const sleeps: number[] = [];
      const fetchImpl = (async () => {
        calls++;
        return calls === 1
          ? fakeResponse({ ok: false, status: 429, retryAfter })
          : fakeResponse({ json: { owned_keys: [] } });
      }) as unknown as typeof fetch;
      await fetchOwnedLibrary({
        apiKey: "key",
        fetchImpl,
        sleepImpl: async (ms) => sleeps.push(ms),
      });
      expect(sleeps).toEqual([1_000]);
    }
  });

  test("gives up after the retry budget and surfaces the 429", async () => {
    const fetchImpl = (async () =>
      fakeResponse({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
      })) as unknown as typeof fetch;

    await expect(
      fetchOwnedLibrary({ apiKey: "key", fetchImpl, sleepImpl: async () => {} })
    ).rejects.toThrow(/429/);
  });

  test("throws a descriptive error when a page's response body isn't valid JSON", async () => {
    const fetchImpl = (async () =>
      ({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => {
          throw new SyntaxError("Unexpected token in JSON");
        },
        headers: { get: () => null },
      }) as unknown as Response) as unknown as typeof fetch;

    await expect(fetchOwnedLibrary({ apiKey: "key", fetchImpl })).rejects.toThrow(
      /non-JSON response/
    );
  });

  test("falls back to '?' for title/classification and empty string for shortText when the game object omits them", async () => {
    const fetchImpl = (async (url: string) => {
      const page = new URL(url).searchParams.get("page");
      const body =
        page === "1" ? { owned_keys: [{ id: 1, game: { id: 10 } }] } : { owned_keys: [] };
      return fakeResponse({ json: body });
    }) as unknown as typeof fetch;

    const packs = await fetchOwnedLibrary({ apiKey: "key", fetchImpl });
    expect(packs[0]).toMatchObject({ title: "?", classification: "?", shortText: "" });
  });

  test("preserves string classification and short-text fields", async () => {
    const fetchImpl = (async (url: string) =>
      fakeResponse({
        json:
          new URL(url).searchParams.get("page") === "1"
            ? {
                owned_keys: [
                  {
                    id: 1,
                    game: { id: 2, title: "Pack", classification: "asset", short_text: "Audio" },
                  },
                ],
              }
            : { owned_keys: [] },
      })) as unknown as typeof fetch;
    expect((await fetchOwnedLibrary({ apiKey: "key", fetchImpl }))[0]).toMatchObject({
      classification: "asset",
      shortText: "Audio",
    });
  });

  test("keeps the API key out of the URL and sends it as a bearer credential", async () => {
    let requested = "";
    let authorization = "";
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      requested = url;
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      return fakeResponse({ json: { owned_keys: [] } });
    }) as unknown as typeof fetch;

    await fetchOwnedLibrary({ apiKey: "key/with space", fetchImpl });
    expect(requested).toBe("https://api.itch.io/profile/owned-keys?page=1");
    expect(requested).not.toContain("key/with space");
    expect(authorization).toBe("Bearer key/with space");
  });

  test("validates options before making a request", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(fetchOwnedLibrary({ apiKey: "   ", fetchImpl })).rejects.toThrow(
      /must not be empty/
    );
    for (const maxPages of [0, -1, 1.5]) {
      await expect(fetchOwnedLibrary({ apiKey: "key", maxPages, fetchImpl })).rejects.toThrow(
        /positive integer/
      );
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test.each([
    { body: { owned_keys: [null] }, message: /not an object/ },
    { body: { owned_keys: [{ id: "1", game: { id: 2 } }] }, message: /invalid key id/ },
    { body: { owned_keys: [{ id: 1, game: { id: "2" } }] }, message: /invalid game id/ },
  ])("rejects malformed owned-key rows ($message)", async ({ body, message }) => {
    const fetchImpl = (async () => fakeResponse({ json: body })) as unknown as typeof fetch;
    await expect(fetchOwnedLibrary({ apiKey: "key", fetchImpl })).rejects.toThrow(message);
  });

  test("uses the real default sleepImpl when retrying a 429 without an injected sleep", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const fetchImpl = (async () => {
        calls++;
        if (calls === 1) return fakeResponse({ ok: false, status: 429, retryAfter: "0" });
        return fakeResponse({ json: { owned_keys: [] } });
      }) as unknown as typeof fetch;

      const promise = fetchOwnedLibrary({ apiKey: "key", fetchImpl });
      // retryAfter "0" -> the default sleepImpl schedules a 0ms setTimeout.
      await vi.runAllTimersAsync();
      const packs = await promise;

      expect(packs).toEqual([]);
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("searchLibrary", () => {
  const packs: OwnedPack[] = [
    {
      keyId: 1,
      gameId: 1,
      title: "UI Sound Effects Pack",
      classification: "asset",
      shortText: "40 crisp interface sounds",
      url: "",
    },
    {
      keyId: 2,
      gameId: 2,
      title: "16x16 Top-Down Tileset",
      classification: "asset",
      shortText: "RPG tiles",
      url: "",
    },
    {
      keyId: 3,
      gameId: 3,
      title: "Low Poly Voxel Pack",
      classification: "asset",
      shortText: "PSX-style models",
      url: "",
    },
  ];

  test("returns every pack when neither query nor bucket is given", () => {
    expect(searchLibrary(packs)).toHaveLength(3);
  });

  test("filters by bucket alone", () => {
    const results = searchLibrary(packs, { bucket: "pixel-2d" });
    expect(results.map((p) => p.title)).toEqual(["16x16 Top-Down Tileset"]);
  });

  test("filters by case-insensitive free-text query against title + shortText", () => {
    const results = searchLibrary(packs, { query: "PSX" });
    expect(results.map((p) => p.title)).toEqual(["Low Poly Voxel Pack"]);
  });

  test("matches query text found only in shortText, not title", () => {
    const results = searchLibrary(packs, { query: "crisp" });
    expect(results.map((p) => p.title)).toEqual(["UI Sound Effects Pack"]);
  });

  test("combines query and bucket, requiring both to match", () => {
    const results = searchLibrary(packs, { query: "voxel", bucket: "3d-psx" });
    expect(results).toHaveLength(1);

    const noMatch = searchLibrary(packs, { query: "voxel", bucket: "audio" });
    expect(noMatch).toHaveLength(0);
  });

  test("treats a blank/whitespace-only query the same as no query", () => {
    expect(searchLibrary(packs, { query: "   " })).toHaveLength(3);
  });

  test("returns an empty array when nothing matches", () => {
    expect(searchLibrary(packs, { query: "nonexistent-keyword" })).toEqual([]);
  });
});
