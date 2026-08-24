import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { requireHttpsUrl } from "./integrity.js";

export interface DownloadHttpsOptions {
  fetchImpl?: typeof fetch;
  allowedHosts?: ReadonlySet<string>;
  headers?: RequestInit["headers"];
  label?: string;
  maxRedirects?: number;
  timeoutMs?: number;
}

function validateHost(
  url: URL,
  allowedHosts: ReadonlySet<string> | undefined,
  label: string
): void {
  if (allowedHosts && !allowedHosts.has(url.hostname)) {
    throw new Error(`${label} uses an unexpected host: ${url.hostname}`);
  }
}

/** Stream an HTTPS response to a new file while pinning every redirect to HTTPS. */
export async function downloadHttpsFile(
  urlValue: string,
  destination: string,
  options: DownloadHttpsOptions = {}
): Promise<void> {
  const label = options.label ?? "download URL";
  const maxRedirects = options.maxRedirects ?? 5;
  if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 20) {
    throw new Error("maxRedirects must be an integer between 0 and 20");
  }
  let url = requireHttpsUrl(urlValue, label);
  const doFetch = options.fetchImpl ?? fetch;
  for (let redirects = 0; redirects <= maxRedirects; redirects++) {
    validateHost(url, options.allowedHosts, label);
    const response = await doFetch(url, {
      redirect: "manual",
      headers: options.headers,
      signal: AbortSignal.timeout(options.timeoutMs ?? 120_000),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`${label} redirect had no Location header`);
      url = requireHttpsUrl(new URL(location, url).href, `${label} redirect`);
      continue;
    }
    if (!response.ok || !response.body) {
      throw new Error(`download failed: HTTP ${response.status} ${response.statusText}`);
    }
    await pipeline(
      Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
      createWriteStream(destination, { flags: "wx" })
    );
    return;
  }
  throw new Error(`${label} exceeded ${maxRedirects} redirects`);
}
