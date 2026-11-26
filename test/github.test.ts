import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { releasePoller, webServer } from "../src/github.js";
import { Store } from "../src/store.js";

const repository = "PrintBench/printbench";
const webhookSecret = "a-staging-test-secret-of-sufficient-length";
const delivery = "7b68c995-85b5-43ce-af7e-7b669a6e3ab4";

test("webhooks verify the exact body, restrict the repository, and persist a single opened event", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "benchy-webhook-"));
  const store = new Store(directory);
  const server = webServer(
    { repository, webhookSecret },
    store,
    () => false,
    () => true,
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const issue = {
    number: 11,
    title: "A first issue",
    user: { login: "staging-user" },
  };
  async function send(
    body: object,
    { valid = true, event = "issues", declaredDelivery = delivery } = {},
  ) {
    const data = JSON.stringify(body);
    const raw = valid ? data : `${data} `;
    return fetch(`${origin}/webhooks/github`, {
      method: "POST",
      body: raw,
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": event,
        "X-GitHub-Delivery": declaredDelivery,
        "X-Hub-Signature-256": `sha256=${createHmac("sha256", webhookSecret).update(data).digest("hex")}`,
      },
    });
  }

  const payload = {
    repository: { full_name: repository },
    action: "opened",
    issue,
  };
  assert.equal((await fetch(`${origin}/health`)).status, 200);
  assert.equal((await fetch(`${origin}/ready`)).status, 503);
  assert.equal((await send(payload, { valid: false })).status, 401);
  assert.equal(
    (await send({ ...payload, repository: { full_name: "other/private" } }))
      .status,
    403,
  );
  assert.equal((await send({ ...payload, action: "edited" })).status, 204);
  assert.equal(
    (await send({ ...payload, issue: { ...issue, number: -1 } })).status,
    400,
  );
  assert.equal((await send(payload)).status, 202);
  assert.equal((await send(payload)).status, 202);
  assert.equal(
    (
      await send(
        { ...payload, pull_request: { ...issue, number: 12 } },
        {
          event: "pull_request",
          declaredDelivery: "7b68c995-85b5-43ce-af7e-7b669a6e3ab5",
        },
      )
    ).status,
    202,
  );

  const reopened = new Store(directory);
  try {
    assert.deepEqual(
      reopened
        .nextJobs()
        .map(({ job }) => job.kind === "activity" && [job.event, job.number]),
      [
        ["issue", 11],
        ["pull", 12],
      ],
    );
  } finally {
    reopened.close();
  }
});

test("release polling baselines the full snapshot and announces a prerelease promotion across restart", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "benchy-release-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const oldRelease = {
    id: 1,
    tag_name: "v1.0.0",
    published_at: "2026-01-01T00:00:00Z",
    prerelease: false,
    body: "Old notes",
  };
  const candidate = {
    ...oldRelease,
    id: 2,
    tag_name: "v1.1.0-rc.1",
    published_at: "2026-01-02T00:00:00Z",
    prerelease: true,
    body: "## What's new\nBetter @everyone support",
  };
  let items = [oldRelease];
  let etag = '"initial"';
  let conditional = 0;
  const mockFetch: typeof fetch = async (_url, init) => {
    if (new Headers(init?.headers).get("If-None-Match") === etag) {
      conditional++;
      return new Response(null, { status: 304 });
    }
    return Response.json(items, { headers: { ETag: etag } });
  };

  const original = new Store(directory);
  try {
    const poll = releasePoller(repository, original, mockFetch);
    assert.deepEqual(await poll(), { initialized: false, queued: 0 });
    assert.equal(original.nextJobs().length, 0);
    assert.deepEqual(await poll(), { initialized: true, queued: 0 });
    assert.equal(conditional, 1);
    items = [candidate, oldRelease];
    etag = '"candidate"';
    assert.deepEqual(await poll(), { initialized: true, queued: 1 });
    const [queued] = original.nextJobs();
    assert.equal(queued.job.kind, "release");
    assert.equal(queued.job.release.summary, "Better @everyone support");
    assert.equal(queued.job.release.prerelease, true);
    original.sent(queued.id, "staging-discord-message");
  } finally {
    original.close();
  }

  const restored = new Store(directory);
  try {
    items = [{ ...candidate, prerelease: false }, oldRelease];
    etag = '"stable"';
    const poll = releasePoller(repository, restored, mockFetch);
    assert.deepEqual(await poll(), { initialized: true, queued: 1 });
    const [queued] = restored.nextJobs();
    assert.equal(queued.job.kind, "release");
    assert.equal(queued.job.release.prerelease, false);
    assert.deepEqual(await poll(), { initialized: true, queued: 0 });
  } finally {
    restored.close();
  }
});

test("a failed page cannot establish a partial release baseline", async () => {
  const store = new Store(":memory:");
  const first = {
    id: 2,
    tag_name: "v2",
    published_at: "2026-02-01T00:00:00Z",
    prerelease: false,
  };
  const second = {
    ...first,
    id: 1,
    tag_name: "v1",
    published_at: "2026-01-01T00:00:00Z",
  };
  let failed = true;
  const get: typeof fetch = async (input) => {
    if (String(input).includes("&page=2")) {
      return failed
        ? new Response(null, { status: 503 })
        : Response.json([second]);
    }
    return Response.json([first], {
      headers: {
        Link: '<https://api.github.com/repositories/10/releases?per_page=100&page=2>; rel="next"',
      },
    });
  };
  try {
    const poll = releasePoller(repository, store, get);
    await assert.rejects(poll, { status: 503 });
    failed = false;
    assert.deepEqual(await poll(), { initialized: false, queued: 0 });
    assert.equal(store.nextJobs().length, 0);
  } finally {
    store.close();
  }
});
