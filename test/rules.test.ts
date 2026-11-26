import assert from "node:assert/strict";
import { test } from "node:test";
import { renderRules } from "../src/rules.js";

const title = "PrintBench Rules";

test("rules up to 4,000 characters use one embed", () => {
  const markdown = "a".repeat(4000);
  const result = renderRules({ title, markdown, continuation: "" });
  assert.equal(result.length, 1);
  assert.equal(result[0].length, 1);
  assert.equal(result[0][0].description, markdown);
});

test("long rules split near a section heading and fit two embeds in one message", () => {
  const markdown = "x".repeat(3750);
  const continuation =
    "## Support\n- [Read the docs](https://docs.printbench.app/)\n" +
    "a".repeat(800);
  const result = renderRules({ title, markdown, continuation });
  assert.equal(result.length, 1);
  assert.equal(result[0].length, 2);
  assert.equal(result[0][0].description, markdown);
  assert.equal(result[0][1].description, continuation);
});

test("two full Markdown fields fit Discord's per-embed and total message budgets", () => {
  const markdown = "x".repeat(4000);
  const continuation = "y".repeat(4000);
  const result = renderRules({
    title: "t".repeat(200),
    markdown,
    continuation,
  });
  assert.equal(result.length, 2);
  assert.equal(result[0][0].description, markdown);
  assert.equal(result[1][0].description, continuation);
  for (const embeds of result) {
    assert.ok(embeds.every((embed) => embed.description!.length <= 4096));
    assert.ok(
      embeds.reduce(
        (size, embed) =>
          size + (embed.title?.length ?? 0) + embed.description!.length,
        0,
      ) <= 6000,
    );
  }
});

test("crossing an embed boundary keeps fenced Markdown and Unicode intact", () => {
  const fence = "```";
  const markdown = `${fence}text\n${"a".repeat(3990)}`;
  const continuation = `${"b".repeat(500)}\n${fence}`;
  const [[first, second]] = renderRules({ title, markdown, continuation });
  assert.ok(first.description?.endsWith(`\n${fence}`));
  assert.ok(second.description?.startsWith(`${fence}text\n`));
  assert.ok(second.description?.endsWith(`\n${fence}`));

  const [[left, right]] = renderRules({
    title,
    markdown: "x".repeat(3999),
    continuation: "🐙".repeat(10),
  });
  assert.ok(left.description?.isWellFormed());
  assert.ok(right.description?.isWellFormed());
  assert.equal(right.description, "🐙".repeat(10));
});
