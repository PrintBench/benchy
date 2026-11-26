import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import type { Config } from "./config.js";
import { errorDetails, log } from "./log.js";
import type { Release, Store } from "./store.js";

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

export function validSignature(
  body: Buffer,
  signature: string | undefined,
  secret: string,
) {
  if (!signature || !/^sha256=[0-9a-f]{64}$/i.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(7), "hex"));
}

export function acceptDelivery(
  store: Store,
  repository: string,
  event: string | undefined,
  delivery: string | undefined,
  data: unknown,
) {
  const payload = object(data);
  const name = object(payload.repository).full_name;
  if (
    typeof name !== "string" ||
    name.toLowerCase() !== repository.toLowerCase()
  )
    return 403;
  if (event !== "issues" && event !== "pull_request") return 204;
  if (payload.action !== "opened") return 204;
  if (
    !delivery ||
    !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(delivery)
  )
    return 400;

  const item = object(payload[event === "issues" ? "issue" : "pull_request"]);
  const author = object(item.user).login;
  const { title, number } = item;
  if (
    typeof number !== "number" ||
    !Number.isSafeInteger(number) ||
    number < 1 ||
    typeof title !== "string" ||
    !title.trim() ||
    typeof author !== "string" ||
    !author.trim()
  )
    return 400;

  const kind = event === "issues" ? "issue" : "pull";
  store.enqueue(`github:${repository.toLowerCase()}:${kind}:${number}`, {
    kind: "activity",
    event: kind,
    delivery,
    number,
    title: title.slice(0, 260),
    author: author.slice(0, 80),
  });
  return 202;
}

async function rawBody(request: IncomingMessage) {
  const maxBytes = 1024 * 1024;
  if (Number(request.headers["content-length"]) > maxBytes) return null;
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > maxBytes) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}

export function webServer(
  config: Pick<Config, "repository" | "webhookSecret">,
  store: Store,
  ready: () => boolean,
  enabled: () => boolean,
) {
  const server = createServer(
    { requestTimeout: 10000, headersTimeout: 5000 },
    async (request, response) => {
      function end(status: number, message?: string) {
        response
          .writeHead(status, { "Content-Type": "text/plain; charset=utf-8" })
          .end(message);
      }

      try {
        if (request.method === "GET" && request.url === "/health")
          return end(200, "ok\n");
        if (request.method === "GET" && request.url === "/ready") {
          return ready()
            ? end(200, "ready\n")
            : end(503, "starting or reconnecting\n");
        }
        if (request.method !== "POST" || request.url !== "/webhooks/github")
          return end(404);
        if (!enabled()) return end(503);
        if (
          request.headers["content-type"]?.split(";")[0].trim() !==
          "application/json"
        )
          return end(415);

        const body = await rawBody(request);
        if (!body) {
          response.setHeader("Connection", "close");
          request.resume();
          return end(413);
        }
        const signature = request.headers["x-hub-signature-256"];
        if (
          !validSignature(
            body,
            typeof signature === "string" ? signature : undefined,
            config.webhookSecret,
          )
        ) {
          return end(401);
        }
        let payload: unknown;
        try {
          payload = JSON.parse(body.toString("utf8"));
        } catch {
          return end(400);
        }
        const event = request.headers["x-github-event"];
        const delivery = request.headers["x-github-delivery"];
        return end(
          acceptDelivery(
            store,
            config.repository,
            typeof event === "string" ? event : undefined,
            typeof delivery === "string" ? delivery : undefined,
            payload,
          ),
        );
      } catch (error) {
        log("error", "http_error", errorDetails(error));
        response.destroyed || end(500);
      }
    },
  );
  return server;
}

function parseRelease(data: unknown): Release | null {
  const {
    id,
    tag_name: tag,
    body,
    published_at: published,
    draft,
    prerelease,
  } = object(data);
  if (draft === true) return null;
  if (
    typeof id !== "number" ||
    !Number.isSafeInteger(id) ||
    id < 1 ||
    typeof tag !== "string" ||
    !tag ||
    typeof published !== "string" ||
    !Number.isFinite(Date.parse(published)) ||
    typeof prerelease !== "boolean"
  )
    throw new Error("Unexpected GitHub release data");
  // The first non-heading lines are the start of the existing GitHub release notes.
  const summary =
    typeof body === "string"
      ? body
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line && !line.startsWith("#"))
          .join("\n")
          .slice(0, 800)
      : "";
  return { id, tag, published, prerelease, summary };
}

type Page = { releases: Release[]; etag: string | null; next: string | null };

export function releasePoller(repository: string, store: Store, get = fetch) {
  const url = new URL(
    `https://api.github.com/repos/${repository}/releases?per_page=100`,
  );
  let cachedPages = new Map<string, Page>();
  let rateLimitedUntil = 0;

  return async function poll() {
    if (Date.now() < rateLimitedUntil) return;
    const pages = new Map<string, Page>();
    let next: string | null = url.href;
    while (next) {
      const address = new URL(next);
      if (
        address.origin !== url.origin ||
        !/^\/(?:repositories\/\d+|repos\/[a-z\d_.-]+\/[a-z\d_.-]+)\/releases$/i.test(
          address.pathname,
        ) ||
        pages.has(next)
      )
        throw new Error("Unexpected GitHub pagination link");

      const cached = cachedPages.get(next);
      const headers = new Headers({
        Accept: "application/vnd.github+json",
        "User-Agent": "PrintBench-Benchy",
      });
      if (cached?.etag) headers.set("If-None-Match", cached.etag);
      const response = await get(address, {
        headers,
        signal: AbortSignal.timeout(10_000),
      });
      let page: Page;
      if (response.status === 304 && cached) {
        page = cached;
      } else {
        if (!response.ok) {
          const retryAfter = response.headers.get("retry-after");
          const reset = response.headers.get("x-ratelimit-reset");
          if (retryAfter && /^\d+$/.test(retryAfter)) {
            rateLimitedUntil = Date.now() + Number(retryAfter) * 1000;
          } else if (
            reset &&
            response.headers.get("x-ratelimit-remaining") === "0"
          ) {
            rateLimitedUntil = Number(reset) * 1000;
          }
          throw Object.assign(new Error("GitHub releases request failed"), {
            status: response.status,
          });
        }
        const data: unknown = await response.json();
        if (!Array.isArray(data))
          throw new Error("Expected a list of GitHub releases");
        page = {
          releases: data
            .map(parseRelease)
            .filter((item): item is Release => item !== null),
          etag: response.headers.get("etag"),
          next:
            /<([^>]+)>; rel="next"/.exec(
              response.headers.get("link") ?? "",
            )?.[1] ?? null,
        };
      }
      pages.set(next, page);
      next = page.next;
    }

    const releases = [...pages.values()]
      .flatMap((page) => page.releases)
      .sort(
        (left, right) =>
          Date.parse(left.published) - Date.parse(right.published),
      );
    const result = store.observeReleases(repository, releases);
    cachedPages = pages;
    if (!result.initialized || result.queued)
      log("info", "release_poll", result);
    return result;
  };
}
