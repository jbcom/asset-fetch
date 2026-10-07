import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { downloadHttpsFile } from "../src/http.js";

describe("downloadHttpsFile", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "asset-fetch-http-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("streams a response and follows a relative HTTPS redirect", async () => {
    const requested: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      requested.push(String(input));
      return requested.length === 1
        ? new Response(null, { status: 302, headers: { location: "/asset.bin" } })
        : new Response("asset");
    }) as unknown as typeof fetch;
    const destination = join(root, "asset.bin");

    await downloadHttpsFile("https://downloads.example/start", destination, {
      allowedHosts: new Set(["downloads.example"]),
      fetchImpl,
    });

    expect(requested).toEqual([
      "https://downloads.example/start",
      "https://downloads.example/asset.bin",
    ]);
    expect(readFileSync(destination, "utf8")).toBe("asset");
  });

  test.each([-1, 21, 1.5])("rejects an invalid redirect limit (%s)", async (maxRedirects) => {
    await expect(
      downloadHttpsFile("https://downloads.example/file", join(root, "file"), { maxRedirects })
    ).rejects.toThrow(/between 0 and 20/);
  });

  test("rejects insecure URLs and redirects, unapproved hosts, and missing locations", async () => {
    await expect(downloadHttpsFile("http://example.com/file", join(root, "a"))).rejects.toThrow(
      /must use https/
    );
    await expect(
      downloadHttpsFile("https://evil.example/file", join(root, "b"), {
        allowedHosts: new Set(["good.example"]),
      })
    ).rejects.toThrow(/unexpected host/);
    await expect(
      downloadHttpsFile("https://good.example/file", join(root, "c"), {
        fetchImpl: (async () => new Response(null, { status: 302 })) as typeof fetch,
      })
    ).rejects.toThrow(/no Location/);
    await expect(
      downloadHttpsFile("https://good.example/file", join(root, "d"), {
        fetchImpl: (async () =>
          new Response(null, {
            status: 302,
            headers: { location: "http://good.example/insecure" },
          })) as typeof fetch,
      })
    ).rejects.toThrow(/redirect must use https/);
  });

  test("reports failed and bodyless responses and redirect exhaustion", async () => {
    await expect(
      downloadHttpsFile("https://example.com/file", join(root, "a"), {
        fetchImpl: (async () => new Response("no", { status: 503 })) as typeof fetch,
      })
    ).rejects.toThrow(/HTTP 503/);
    await expect(
      downloadHttpsFile("https://example.com/file", join(root, "b"), {
        fetchImpl: (async () => new Response(null, { status: 204 })) as typeof fetch,
      })
    ).rejects.toThrow(/download failed/);
    await expect(
      downloadHttpsFile("https://example.com/file", join(root, "c"), {
        maxRedirects: 0,
        fetchImpl: (async () =>
          new Response(null, {
            status: 302,
            headers: { location: "https://example.com/again" },
          })) as typeof fetch,
      })
    ).rejects.toThrow(/exceeded 0 redirects/);
  });
});
