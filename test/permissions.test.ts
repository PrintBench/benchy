import assert from "node:assert/strict";
import { test } from "node:test";
import { OverwriteType, PermissionFlagsBits } from "discord.js";
import { coversSupportAudience, isRoleGated } from "../src/permissions.js";

const { ViewChannel, ReadMessageHistory } = PermissionFlagsBits;
const make = (
  id: string,
  allow: bigint,
  deny: bigint,
  type = OverwriteType.Role,
) => ({ id, allow, deny, type });

test("Support copies only from public sources or equivalent role visibility", () => {
  const base = ViewChannel | ReadMessageHistory;
  const restricted = [
    make("everyone", 0n, ViewChannel),
    make("supporter", ViewChannel, 0n),
  ];
  assert.equal(coversSupportAudience(base, "everyone", [], restricted), true);
  assert.equal(
    coversSupportAudience(
      base,
      "everyone",
      restricted,
      [...restricted].reverse(),
    ),
    true,
  );
  assert.equal(coversSupportAudience(base, "everyone", restricted, []), false);
  assert.equal(
    coversSupportAudience(
      base,
      "everyone",
      [make("individual", 0n, ReadMessageHistory, OverwriteType.Member)],
      [],
    ),
    false,
  );
  assert.equal(coversSupportAudience(ViewChannel, "everyone", [], []), false);
});

test("GitHub and audit channels require a private everyone overwrite and reject unexpected viewers", () => {
  const privateChannel = [
    make("everyone", 0n, ViewChannel),
    make("staff", ViewChannel, 0n),
    make("benchy", ViewChannel, 0n),
  ];
  assert.equal(
    isRoleGated("everyone", privateChannel, ["staff", "benchy"]),
    true,
  );
  assert.equal(
    isRoleGated("everyone", privateChannel.slice(1), ["staff", "benchy"]),
    false,
  );
  assert.equal(
    isRoleGated(
      "everyone",
      privateChannel,
      ["staff", "benchy", "opt-in"],
      "opt-in",
    ),
    false,
  );
  assert.equal(
    isRoleGated(
      "everyone",
      [...privateChannel, make("opt-in", ViewChannel, 0n)],
      ["staff", "benchy", "opt-in"],
      "opt-in",
    ),
    true,
  );
  assert.equal(
    isRoleGated(
      "everyone",
      [
        ...privateChannel,
        make("visitor", ViewChannel, 0n, OverwriteType.Member),
      ],
      ["staff", "benchy"],
    ),
    false,
  );
});
