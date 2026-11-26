import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ChannelType,
  Collection,
  MessageFlags,
  OverwriteType,
  PermissionsBitField,
} from "discord.js";
import type {
  APIEmbed,
  Guild,
  Interaction,
  MessageCreateOptions,
  ModalBuilder,
} from "discord.js";
import { commandHandlers } from "../src/commands.js";
import { loadConfig } from "../src/config.js";
import type { Config } from "../src/config.js";
import { contributorClaims } from "../src/contributors.js";
import {
  checkDiscordSetup,
  DiscordSetupError,
  drainJobs,
  reconcileMemberEvents,
  validateGuild,
} from "../src/discord.js";
import { acceptDelivery } from "../src/github.js";
import { Store } from "../src/store.js";

const ids = Array.from({ length: 22 }, (_, index) =>
  String(101000000000000000n + BigInt(index)),
);
const [
  guildId,
  release,
  releaseRole,
  pullChannel,
  pullRole,
  forum,
  source,
  audit,
  modRole,
  welcome,
  rules,
  moderator,
  author,
  bot,
  botRole,
  thread,
  original,
  command,
  privileged,
  contributorRole,
  issueChannel,
  issueRole,
] = ids;
const config: Config = {
  token: "test-only",
  guild: guildId,
  releases: release,
  releaseRole,
  github: {
    pull: { channel: pullChannel, role: pullRole },
    issue: { channel: issueChannel, role: issueRole },
  },
  support: forum,
  sources: [source],
  audit,
  moderators: [modRole],
  welcome,
  rules,
  repository: "PrintBench/printbench",
  webhookSecret: "staging",
  port: 3000,
  dataDirectory: ":memory:",
};
const configWithContributor: Config = {
  ...config,
  contributor: {
    role: contributorRole,
    oauth: {
      secret: "test-secret",
      redirect: "https://benchy.example.com/oauth/discord/callback",
    },
  },
};

function setup({ crossFeedAccess = false } = {}) {
  const store = new Store(":memory:");
  const operations: { channel: string; message: MessageCreateOptions }[] = [];
  const auditErrors: Error[] = [];
  const bans = new Map<
    string,
    { reason: string; deleteMessageSeconds: number }
  >();
  const posts: { name: string; message: { content: string } }[] = [];
  const timeouts: { id: string; until: number | null; reason: string }[] = [];
  const kicks: { id: string; reason: string }[] = [];
  const full = new PermissionsBitField(PermissionsBitField.All);
  const ordinary = new PermissionsBitField([
    "ViewChannel",
    "ReadMessageHistory",
    "SendMessagesInThreads",
  ]);
  const joined = 1760000000000;

  function staffMember(id: string, level: number, staff = false) {
    const cache = new Collection(staff ? [[modRole, {}]] : []);
    return {
      id,
      guild: { ownerId: "owner" },
      user: { id, bot: id === bot },
      pending: false,
      joinedTimestamp: joined,
      isCommunicationDisabled: () => false,
      roles: {
        cache,
        add: async (role: string) => cache.set(role, {}),
        highest: {
          level,
          comparePositionTo: (other: { level: number }) => level - other.level,
        },
        botRole: id === bot ? { id: botRole } : undefined,
      },
      permissions: staff ? full : ordinary,
      async kick(reason: string) {
        kicks.push({ id, reason });
      },
      async disableCommunicationUntil(until: number | null, reason: string) {
        timeouts.push({ id, until, reason });
      },
    };
  }

  function text(id: string, privateRoles?: string[]) {
    const cache = new Collection<
      string,
      {
        type: OverwriteType;
        allow: PermissionsBitField;
        deny: PermissionsBitField;
      }
    >();
    if (privateRoles) {
      cache.set(guildId, {
        type: OverwriteType.Role,
        allow: new PermissionsBitField(),
        deny: new PermissionsBitField(["ViewChannel"]),
      });
      for (const role of privateRoles) {
        cache.set(role, {
          type: OverwriteType.Role,
          allow: new PermissionsBitField(["ViewChannel"]),
          deny: new PermissionsBitField(),
        });
      }
    }
    return {
      id,
      type: ChannelType.GuildText,
      permissionOverwrites: { cache },
      nsfw: false,
      flags: { has: () => false },
      permissionsFor: () => full,
      messages: {
        fetch: async (query: { message?: string }) =>
          query.message ? { editedTimestamp: null } : new Collection(),
      },
      send: async (message: MessageCreateOptions) => {
        if (id === audit && auditErrors.length) throw auditErrors.shift();
        operations.push({ channel: id, message });
        return { id: `sent-${operations.length}` };
      },
    };
  }

  const general = text(source);
  const support = {
    ...text(forum),
    type: ChannelType.GuildForum,
    flags: { has: () => false },
    availableTags: [{ id: "solved-tag", name: "Solved", moderated: true }],
    allCanReply: true,
    permissionsFor(person: { id: string }) {
      return person.id === author && !this.allCanReply
        ? new PermissionsBitField(["ViewChannel"])
        : full;
    },
    threads: {
      create: async (options: (typeof posts)[number]) => {
        posts.push(options);
        return { id: thread };
      },
    },
  };
  const post = {
    id: thread,
    parentId: forum,
    locked: false,
    archived: false,
    isThread: () => true,
    permissionsFor: () => full,
    appliedTags: ["question-tag"],
    async setAppliedTags(tags: string[]) {
      this.appliedTags = tags;
    },
    async edit(options: { locked: boolean; archived: boolean }) {
      this.locked = options.locked;
      this.archived = options.archived;
      return this;
    },
  };
  type RulesPost = {
    id: string;
    embeds: APIEmbed[];
    createdTimestamp: number;
    author: { id: string };
  };
  const rulesPosts = new Collection<string, RulesPost>();
  const rulesErrors: Error[] = [];
  let rulesPostCount = 0;
  const rulesChannel = {
    ...text(rules),
    client: { user: { id: bot } },
    messages: {
      fetch: async (query: { message?: string }) => {
        if (!query.message) return rulesPosts;
        const existing = rulesPosts.get(query.message);
        if (!existing)
          throw Object.assign(new Error("Unknown message"), { code: 10008 });
        return existing;
      },
    },
    send: async (message: {
      embeds: APIEmbed[];
      allowedMentions: MessageCreateOptions["allowedMentions"];
    }) => {
      assert.deepEqual(message.allowedMentions?.parse, []);
      const published = {
        id: `rules-${++rulesPostCount}`,
        embeds: message.embeds,
        createdTimestamp: Date.now(),
        author: { id: bot },
        async edit(options: { embeds: APIEmbed[] }) {
          this.embeds = options.embeds;
          return this;
        },
        async delete() {
          rulesPosts.delete(this.id);
        },
      };
      rulesPosts.set(published.id, published);
      if (rulesErrors.length) throw rulesErrors.shift();
      return published;
    },
  };
  const channels = [
    text(release),
    text(pullChannel, [botRole, pullRole]),
    text(
      issueChannel,
      crossFeedAccess ? [botRole, issueRole, pullRole] : [botRole, issueRole],
    ),
    general,
    support,
    text(audit, [modRole, botRole]),
    text(welcome),
    rulesChannel,
    post,
  ];
  const people = new Map([
    [moderator, staffMember(moderator, 10, true)],
    [author, staffMember(author, 1)],
    [bot, staffMember(bot, 20, true)],
    [privileged, staffMember(privileged, 15, true)],
  ]);
  const guild = {
    id: guildId,
    client: { user: { id: bot } },
    channels: {
      fetch: async (id: string) =>
        channels.find((channel) => channel.id === id),
    },
    members: {
      me: people.get(bot),
      fetch: async ({ user }: { user: string }) => people.get(user),
      fetchMe: async () => people.get(bot),
    },
    roles: {
      everyone: { permissions: ordinary },
      cache: new Collection(
        [releaseRole, pullRole, issueRole, modRole].map((id) => [
          id,
          { id, mentionable: id === releaseRole },
        ]),
      ),
      fetch: async (role?: string) =>
        role
          ? { id: releaseRole, mentionable: true }
          : new Collection([
              [
                contributorRole,
                {
                  id: contributorRole,
                  level: 2,
                  permissions: new PermissionsBitField(),
                },
              ],
            ]),
    },
    bans: {
      fetch: async ({ user }: { user: string }) => {
        const result = bans.get(user);
        if (!result)
          throw Object.assign(new Error("Unknown Ban"), {
            code: 10026,
            status: 404,
          });
        return result;
      },
      create: async (
        id: string,
        details: { reason: string; deleteMessageSeconds: number },
      ) => bans.set(id, details),
    },
  } as unknown as Guild;
  return {
    store,
    bans,
    guild,
    people,
    auditErrors,
    general,
    support,
    operations,
    posts,
    post,
    joined,
    kicks,
    timeouts,
    rulesPosts,
    rulesErrors,
  };
}

type Response = { content?: string; [key: string]: unknown };

test("Discord setup reports the affected channel setting and preserves the original error code", async (t) => {
  const { guild, store } = setup();
  t.after(() => store.close());
  const fetchChannel = guild.channels.fetch.bind(guild.channels);
  const denial = Object.assign(new Error("Raw Discord response"), {
    code: 50001,
    status: 403,
  });
  let deniedChannel = issueChannel;
  t.mock.method(
    guild.channels,
    "fetch",
    async (id: string, options: object) => {
      if (id === deniedChannel) throw denial;
      return fetchChannel(id, options);
    },
  );
  const expected = (step: string, id: string) => (error: unknown) => {
    assert.ok(error instanceof DiscordSetupError);
    assert.equal(error.step, step);
    assert.equal(error.cause, denial);
    assert.ok(
      error.message.includes(id) && error.message.includes("View Channel"),
    );
    return true;
  };
  await assert.rejects(
    validateGuild(guild, config),
    expected("DISCORD_GITHUB_ISSUE_CHANNEL_ID", issueChannel),
  );
  deniedChannel = source;
  await assert.rejects(
    validateGuild(guild, config),
    expected("DISCORD_SUPPORT_SOURCE_IDS", source),
  );
});

test("Discord setup preserves transient errors for the existing retry loop", async () => {
  const outage = Object.assign(new Error("Discord unavailable"), {
    status: 503,
  });
  await assert.rejects(
    checkDiscordSetup(
      "register_guild_commands",
      "Check the install",
      async () => {
        throw outage;
      },
    ),
    (error) => error === outage,
  );
});

function interaction(
  guild: Guild,
  type: "slash" | "message" | "modal" | "button",
  changes: object,
) {
  const output: Response[] = [];
  const state = {
    id: command,
    user: { id: moderator },
    guild,
    guildId,
    channelId: source,
    member: {
      id: moderator,
      guild: { ownerId: "owner" },
      roles: { cache: new Collection([[modRole, {}]]) },
      permissions: new PermissionsBitField(PermissionsBitField.All),
    },
    memberPermissions: new PermissionsBitField(PermissionsBitField.All),
    inCachedGuild: () => true,
    isRepliable: () => true,
    isChatInputCommand: () => type === "slash",
    isMessageContextMenuCommand: () => type === "message",
    isModalSubmit: () => type === "modal",
    isButton: () => type === "button",
    deferred: false,
    replied: false,
    async deferReply() {
      this.deferred = true;
    },
    async deferUpdate() {
      this.deferred = true;
    },
    async reply(body: Response) {
      this.replied = true;
      output.push(body);
    },
    async update(body: Response) {
      this.replied = true;
      output.push(body);
    },
    async followUp(body: Response) {
      output.push(body);
    },
    async editReply(body: Response | string) {
      output.push(typeof body === "string" ? { content: body } : body);
    },
    async showModal(body: Response) {
      this.replied = true;
      output.push(body);
    },
    ...changes,
  };
  return { input: state as unknown as Interaction, output };
}

test("support copies the chosen message once, queues a reply, and refuses unsafe source and author permissions", async (t) => {
  const { store, guild, general, support, posts, operations } = setup();
  t.after(() => store.close());
  const handle = commandHandlers(config, store);
  async function route() {
    const menu = interaction(guild, "message", {
      commandName: "Send to Support",
      targetMessage: {
        id: original,
        channelId: source,
        author: { id: author },
        content: "Help with Docker @everyone",
        editedTimestamp: null,
        attachments: new Collection([["file", {}]]),
      },
    });
    await handle(menu.input);
    assert.ok(menu.output.length);
    const modal = interaction(guild, "modal", {
      customId: `support:${command}`,
      fields: {
        getTextInputValue: () => "Docker question",
      },
    });
    await handle(modal.input);
    return modal.output.at(-1)?.content;
  }

  general.permissionOverwrites.cache.set(guildId, {
    type: OverwriteType.Role,
    allow: new PermissionsBitField(),
    deny: new PermissionsBitField(["ViewChannel"]),
  });
  assert.match((await route()) ?? "", /does not safely cover/);
  general.permissionOverwrites.cache.clear();
  support.allCanReply = false;
  assert.match((await route()) ?? "", /author needs access/);
  support.allCanReply = true;
  assert.match((await route()) ?? "", /queued a redirect/);
  assert.match((await route()) ?? "", /Already routed/);
  assert.equal(posts.length, 1);
  assert.match(posts[0].message.content, /Help with Docker/);
  assert.match(
    posts[0].message.content,
    /Attachments are available on the original/,
  );
  await drainJobs(guild, config, store);
  assert.equal(operations.length, 1);
  assert.equal(operations[0].message.reply?.messageReference, original);
  assert.deepEqual(operations[0].message.allowedMentions?.parse, []);
});

test("ban cancellation and hierarchy protect members, and an audit retry never issues another ban", async (t) => {
  const { store, guild, bans, auditErrors, operations } = setup();
  t.after(() => store.close());
  const handle = commandHandlers(config, store);
  async function ban(target: string, decision: "confirm" | "cancel") {
    const slash = interaction(guild, "slash", {
      commandName: "ban",
      options: { getString: () => "Spam", getUser: () => ({ id: target }) },
    });
    await handle(slash.input);
    assert.equal(slash.output[0].flags, MessageFlags.Ephemeral);
    const button = interaction(guild, "button", {
      customId: `ban-${decision}:${command}`,
    });
    await handle(button.input);
    return button.output.at(-1)?.content;
  }

  assert.equal(await ban(author, "cancel"), "Ban cancelled.");
  assert.equal(bans.size, 0);
  assert.match((await ban(privileged, "confirm")) ?? "", /role hierarchy/);
  assert.equal(bans.size, 0);
  assert.equal(
    await ban(author, "confirm"),
    "Member banned. The audit entry is queued.",
  );
  assert.equal(bans.get(author)?.deleteMessageSeconds, 0);
  assert.match(bans.get(author)?.reason ?? "", new RegExp(moderator));
  auditErrors.push(
    Object.assign(new Error("Discord unavailable"), { status: 503 }),
  );
  await drainJobs(guild, config, store);
  assert.equal(operations.length, 0);
  store.retry(`audit:${command}`, "retry sooner in test", 0);
  await drainJobs(guild, config, store);
  assert.equal(operations.length, 1);
  assert.equal(operations[0].channel, audit);
  assert.equal(bans.size, 1);
});

test("the same post can be locked in the forum and unlocked by link elsewhere", async (t) => {
  const { store, guild, post } = setup();
  t.after(() => store.close());
  const handle = commandHandlers(config, store);
  const lock = interaction(guild, "slash", {
    commandName: "lock",
    channelId: thread,
  });
  await handle(lock.input);
  assert.equal(post.locked, true);
  assert.equal(post.archived, true);
  const unlock = interaction(guild, "slash", {
    commandName: "unlock",
    options: {
      getString: () => `https://discord.com/channels/${guildId}/${thread}`,
    },
  });
  await handle(unlock.input);
  assert.equal(post.locked, false);
  assert.equal(post.archived, false);
});

test("announcements only ping the release role for stable releases and welcome after screening once per join", async (t) => {
  const { store, guild, people, operations, joined } = setup();
  t.after(() => store.close());
  for (const prerelease of [true, false]) {
    store.enqueue(`release:${prerelease}`, {
      kind: "release",
      release: {
        id: 1,
        tag: "v1.2.3",
        prerelease,
        summary: "Changes @everyone",
        published: "2026-01-01T00:00:00Z",
      },
    });
  }
  const person = people.get(author)!;
  person.pending = true;
  store.rememberScreening(author, joined);
  await reconcileMemberEvents(guild, store);
  await drainJobs(guild, config, store);
  assert.equal(operations.length, 2);
  const [quietRelease, stableRelease] = operations.map(
    (entry) => entry.message,
  );
  assert.equal(quietRelease.flags, MessageFlags.SuppressNotifications);
  assert.deepEqual(quietRelease.allowedMentions?.roles, []);
  assert.equal(stableRelease.content, `<@&${releaseRole}>`);
  assert.deepEqual(stableRelease.allowedMentions?.roles, [releaseRole]);
  assert.deepEqual(stableRelease.allowedMentions?.parse, []);

  person.pending = false;
  await reconcileMemberEvents(guild, store);
  store.welcome(author, joined);
  await drainJobs(guild, config, store);
  assert.equal(
    operations.filter((entry) => entry.channel === welcome).length,
    1,
  );
  person.joinedTimestamp++;
  store.welcome(author, person.joinedTimestamp);
  await drainJobs(guild, config, store);
  assert.equal(
    operations.filter((entry) => entry.channel === welcome).length,
    2,
  );
});

test("a confirmed Discord ban recovered from an interrupted request queues the private audit", async (t) => {
  const { store, guild, bans, operations } = setup();
  t.after(() => store.close());
  const pending = {
    id: command,
    moderator,
    target: author,
    reason: "Spam",
    created: Date.now() - 65_000,
  };
  assert.equal(store.reserveBan(pending), true);
  bans.set(author, {
    reason: `Benchy ${command} | Moderator ${moderator} | Spam`,
    deleteMessageSeconds: 0,
  });
  await reconcileMemberEvents(guild, store);
  await reconcileMemberEvents(guild, store);
  await drainJobs(guild, config, store);
  assert.deepEqual(
    operations.map(({ channel }) => channel),
    [audit],
  );
  assert.deepEqual(store.status().pendingBans, []);
});

test("the info command posts the five PrintBench links in a public response", async (t) => {
  const { store, guild } = setup();
  t.after(() => store.close());
  const handle = commandHandlers(config, store);
  const result = interaction(guild, "slash", { commandName: "info" });
  await handle(result.input);
  const reply = result.output[0] as MessageCreateOptions;
  assert.equal(reply.flags, undefined);
  const [embed] = reply.embeds ?? [];
  assert.ok("toJSON" in embed);
  const description = embed.toJSON().description;
  for (const url of [
    "https://printbench.app/",
    "https://docs.printbench.app/",
    "https://github.com/PrintBench/printbench",
    "https://github.com/PrintBench/printbench/releases/latest",
    "https://github.com/PrintBench/printbench/releases/latest/download/compose.yaml",
  ]) {
    assert.ok(description?.includes(`(${url})`));
  }
});

test("Support's Solved tag can be set and cleared without replacing other tags", async (t) => {
  const { store, guild, post } = setup();
  t.after(() => store.close());
  const handle = commandHandlers(config, store);
  async function resolve(solved: boolean | null = null) {
    const action = interaction(guild, "slash", {
      commandName: "resolve",
      channelId: thread,
      options: { getBoolean: () => solved },
    });
    await handle(action.input);
    return action.output.at(-1)?.content;
  }
  await resolve();
  await resolve();
  assert.deepEqual(post.appliedTags, ["question-tag", "solved-tag"]);
  await resolve(false);
  assert.deepEqual(post.appliedTags, ["question-tag"]);
  post.appliedTags = ["one", "two", "three", "four", "five"];
  assert.match((await resolve()) ?? "", /Remove one existing tag/);
  assert.equal(post.appliedTags.length, 5);
  post.appliedTags = ["question-tag"];
  post.archived = true;
  assert.match((await resolve()) ?? "", /Reopen the Support post/);
  assert.equal(post.archived, true);
});

test("kicks and timeouts require confirmation and send successful actions to the private audit queue", async (t) => {
  const { store, guild, kicks, timeouts, operations } = setup();
  t.after(() => store.close());
  const handle = commandHandlers(config, store);
  async function moderate(
    commandName: "kick" | "timeout" | "untimeout",
    decision: "confirm" | "cancel",
    options = { target: author, minutes: 15 },
  ) {
    const id = String(BigInt(command) + BigInt(++sequence));
    const slash = interaction(guild, "slash", {
      id,
      commandName,
      options: {
        getString: () => "Disruptive behaviour",
        getInteger: () => options.minutes,
        getUser: () => ({ id: options.target }),
      },
    });
    await handle(slash.input);
    assert.equal(slash.output[0].flags, MessageFlags.Ephemeral);
    const button = interaction(guild, "button", {
      customId: `${commandName}-${decision}:${id}`,
    });
    await handle(button.input);
    return button.output.at(-1)?.content;
  }
  let sequence = 0;
  assert.equal(await moderate("kick", "cancel"), "Kick cancelled.");
  assert.equal(kicks.length, 0);
  assert.match(
    (await moderate("timeout", "confirm", {
      target: privileged,
      minutes: 15,
    })) ?? "",
    /role hierarchy/,
  );
  assert.equal(timeouts.length, 0);
  await moderate("timeout", "confirm");
  assert.equal(timeouts[0].id, author);
  assert.ok(timeouts[0].until! - Date.now() <= 15 * 60_000);
  assert.ok(timeouts[0].until! - Date.now() > 14 * 60_000);
  await moderate("untimeout", "confirm");
  assert.equal(timeouts[1].until, null);
  await moderate("kick", "confirm");
  assert.deepEqual(
    kicks.map(({ id }) => id),
    [author],
  );
  await drainJobs(guild, config, store);
  assert.deepEqual(
    operations.map(({ channel }) => channel),
    [audit, audit, audit],
  );
});

test("a moderator can recognize a GitHub issue contribution while ordinary members cannot grant roles", async (t) => {
  const { store, guild, people } = setup();
  t.after(() => store.close());
  const handle = commandHandlers(configWithContributor, store);
  const base = {
    commandName: "contributor",
    options: {
      getSubcommand: () => "grant",
      getUser: () => ({ id: author }),
      getString: (option: string) =>
        option === "evidence"
          ? "https://github.com/PrintBench/printbench-docs/issues/4#issuecomment-5"
          : null,
    },
  };
  const regular = interaction(guild, "slash", {
    ...base,
    user: { id: author },
    member: people.get(author),
  });
  await handle(regular.input);
  assert.match(
    regular.output.at(-1)?.content ?? "",
    /Only PrintBench moderators/,
  );
  assert.equal(people.get(author)?.roles.cache.has(contributorRole), false);

  const staff = interaction(guild, "slash", base);
  await handle(staff.input);
  assert.match(staff.output.at(-1)?.content ?? "", /Contributor role granted/);
  assert.equal(people.get(author)?.roles.cache.has(contributorRole), true);
  const [job] = store.nextJobs();
  assert.equal(job.job.kind, "member-audit");
  assert.match(
    job.job.entry.evidence ?? "",
    /printbench-docs\/issues\/4#issuecomment-5$/,
  );
});

test("Contributor claims bind OAuth to the Discord user and verify merged PR authorship across organization repositories", async (t) => {
  const { store, guild, people } = setup();
  t.after(() => store.close());
  const account = "22135084";
  let signedIn = privileged;
  let githubFetches = 0;
  let prAuthor = 12;
  let mergedAt: string | null = "2026-01-01T00:00:00Z";
  const safeFetch: typeof fetch = async (input, options) => {
    const url = new URL(String(input));
    if (url.host === "discord.com") {
      if (url.pathname.endsWith("/token")) {
        assert.equal(options?.method, "POST");
        assert.equal(
          (options?.body as URLSearchParams).get("redirect_uri"),
          configWithContributor.contributor?.oauth?.redirect,
        );
        return Response.json({ access_token: "test-oauth-access-token" });
      }
      if (url.pathname.endsWith("/@me")) return Response.json({ id: signedIn });
      return Response.json([
        { type: "github", id: account, verified: true, visibility: 0 },
      ]);
    }
    githubFetches++;
    assert.equal(url.host, "api.github.com");
    if (url.pathname.startsWith("/user/")) {
      assert.equal(url.pathname, `/user/${account}`);
      return Response.json({
        login: "contributor-renamed",
        id: Number(account),
        type: "User",
      });
    }
    assert.equal(
      url.searchParams.get("q"),
      "org:PrintBench is:pr is:merged author:contributor-renamed",
    );
    return Response.json({
      incomplete_results: false,
      items: [
        {
          user: { id: prAuthor },
          html_url: "https://github.com/PrintBench/printbench-docs/pull/4",
          pull_request: { merged_at: mergedAt },
        },
      ],
    });
  };
  const claims = contributorClaims(
    configWithContributor,
    store,
    () => guild,
    safeFetch,
  )!;
  function link(member: string, id: string) {
    const authorize = new URL(claims.start(member, bot, id));
    assert.equal(authorize.searchParams.get("scope"), "identify connections");
    const data = new URLSearchParams({
      state: authorize.searchParams.get("state")!,
      code: "code",
    });
    return new URL(`https://benchy.example.com/oauth/discord/callback?${data}`);
  }
  const mismatch = link(author, "1");
  assert.equal((await claims.complete(mismatch)).status, 403);
  assert.equal(githubFetches, 0);
  assert.equal((await claims.complete(mismatch)).status, 400);

  signedIn = author;
  assert.equal((await claims.complete(link(author, "2"))).status, 422);
  assert.equal(people.get(author)?.roles.cache.has(contributorRole), false);
  prAuthor = Number(account);
  mergedAt = null;
  assert.equal((await claims.complete(link(author, "3"))).status, 422);
  mergedAt = "2026-01-01T00:00:00Z";
  assert.equal((await claims.complete(link(author, "4"))).status, 200);
  assert.equal(people.get(author)?.roles.cache.has(contributorRole), true);
  assert.equal(store.nextJobs().length, 1);
  assert.equal((await claims.complete(link(author, "5"))).status, 200);
  assert.equal(store.nextJobs().length, 1);

  signedIn = privileged;
  assert.equal((await claims.complete(link(privileged, "6"))).status, 422);
  assert.equal(people.get(privileged)?.roles.cache.has(contributorRole), false);
});

function rulesFlow(guild: Guild, store: Store) {
  const handle = commandHandlers(config, store);
  let next = 1;
  const id = () => String(BigInt(command) + BigInt(100 + next++));
  return {
    async open(changes = {}) {
      const slash = interaction(guild, "slash", {
        id: id(),
        commandName: "setup",
        ...changes,
      });
      await handle(slash.input);
      return slash;
    },
    async preview(form: string, markdown: string, continuation = "") {
      const values = new Map([
        ["title", "Server Rules"],
        ["markdown", markdown],
      ]);
      if (continuation) values.set("continuation", continuation);
      const modal = interaction(guild, "modal", {
        id: id(),
        customId: `rules:form:${form}`,
        fields: {
          fields: values,
          getTextInputValue: (key: string) => values.get(key),
        },
      });
      await handle(modal.input);
      return modal;
    },
    async choose(preview: string, action: "publish" | "cancel" | "edit") {
      const button = interaction(guild, "button", {
        id: id(),
        customId: `rules:${action}:${preview}`,
      });
      await handle(button.input);
      return button;
    },
  };
}

test("rules require Manage Server and preview privately before stable publication", async (t) => {
  const { store, guild, people, rulesPosts } = setup();
  t.after(() => store.close());
  const flow = rulesFlow(guild, store);
  const denied = await flow.open({
    user: { id: author },
    member: people.get(author),
  });
  assert.equal(denied.output[0].flags, MessageFlags.Ephemeral);
  assert.match(denied.output[0].content ?? "", /need Manage Server/);

  const opened = await flow.open();
  const modal = (opened.output[0] as unknown as ModalBuilder).toJSON();
  assert.equal(modal.title, "Set up server rules");
  const preview = await flow.preview(
    opened.input.id,
    "First draft",
    "a".repeat(3998),
  );
  assert.equal(rulesPosts.size, 0);
  assert.match(preview.output[0].content ?? "", /Preview/);
  const edit = await flow.choose(preview.input.id, "edit");
  const editForm = (edit.output[0] as unknown as ModalBuilder).toJSON();
  assert.match(JSON.stringify(editForm), /First draft/);
  const edited = await flow.preview(edit.input.id, "Edited draft");
  await flow.choose(edited.input.id, "cancel");
  assert.equal(rulesPosts.size, 0);

  const large = await flow.preview(
    (await flow.open()).input.id,
    "a".repeat(4000),
    "b".repeat(4000),
  );
  assert.equal(large.output.length, 2);
  assert.equal(large.output[1].flags, MessageFlags.Ephemeral);
  assert.equal(rulesPosts.size, 0);
  const concurrent = await flow.preview(
    (await flow.open()).input.id,
    "An outdated draft",
  );
  await flow.choose(large.input.id, "publish");
  assert.equal(rulesPosts.size, 2);
  const [primary, secondary] = store
    .readRules(rules)
    .messages.map(({ id }) => id!);
  assert.equal(rulesPosts.get(primary)?.embeds[0].description?.length, 4000);
  assert.equal(rulesPosts.get(secondary)?.embeds[0].description?.length, 4000);
  const stale = await flow.choose(concurrent.input.id, "publish");
  assert.match(
    stale.output.at(-1)?.content ?? "",
    /changed after this preview/,
  );

  const revised = await flow.preview((await flow.open()).input.id, "New rules");
  assert.match(
    revised.output[0].content ?? "",
    /removes Benchy's old continuation/,
  );
  await flow.choose(revised.input.id, "publish");
  assert.deepEqual([...rulesPosts.keys()], [primary]);
  assert.equal(rulesPosts.get(primary)?.embeds[0].description, "New rules");
  const reopened = await flow.open();
  assert.match(
    JSON.stringify((reopened.output[0] as unknown as ModalBuilder).toJSON()),
    /New rules/,
  );
});

test("publishing after an interrupted Discord response recovers the original rules message", async (t) => {
  const { store, guild, rulesPosts, rulesErrors } = setup();
  t.after(() => store.close());
  let flow = rulesFlow(guild, store);
  const preview = await flow.preview(
    (await flow.open()).input.id,
    "Rules before interruption",
  );
  rulesErrors.push(
    Object.assign(new Error("Connection lost"), { status: 503 }),
  );
  await flow.choose(preview.input.id, "publish");
  assert.equal(rulesPosts.size, 1);
  const [published] = [...rulesPosts.keys()];

  flow = rulesFlow(guild, store);
  const retry = await flow.preview(
    (await flow.open()).input.id,
    "Rules after interruption",
  );
  await flow.choose(retry.input.id, "publish");
  assert.deepEqual([...rulesPosts.keys()], [published]);
  assert.equal(
    rulesPosts.get(published)?.embeds[0].description,
    "Rules after interruption",
  );
  assert.equal(store.readRules(rules).messages[0].id, published);
});

const githubEnv = {
  DISCORD_TOKEN: "test-only",
  DISCORD_GUILD_ID: guildId,
  DISCORD_RELEASES_CHANNEL_ID: release,
  DISCORD_RELEASE_PINGS_ROLE_ID: releaseRole,
  DISCORD_GITHUB_PULL_CHANNEL_ID: pullChannel,
  DISCORD_GITHUB_PULL_ROLE_ID: pullRole,
  DISCORD_GITHUB_ISSUE_CHANNEL_ID: issueChannel,
  DISCORD_GITHUB_ISSUE_ROLE_ID: issueRole,
  DISCORD_SUPPORT_FORUM_ID: forum,
  DISCORD_SUPPORT_SOURCE_IDS: source,
  DISCORD_MOD_LOG_CHANNEL_ID: audit,
  DISCORD_MODERATOR_ROLE_IDS: modRole,
  DISCORD_WELCOME_CHANNEL_ID: welcome,
  DISCORD_RULES_CHANNEL_ID: rules,
  GITHUB_WEBHOOK_SECRET: "test-only-webhook-secret-with-enough-characters",
};

test("GitHub feeds require distinct roles and channels", () => {
  assert.deepEqual(loadConfig(githubEnv).github, config.github);
  assert.throws(
    () => loadConfig({ ...githubEnv, DISCORD_GITHUB_ISSUE_ROLE_ID: pullRole }),
    /DISCORD_GITHUB_PULL_ROLE_ID, DISCORD_GITHUB_ISSUE_ROLE_ID/,
  );
  assert.throws(
    () =>
      loadConfig({
        ...githubEnv,
        DISCORD_GITHUB_ISSUE_CHANNEL_ID: pullChannel,
      }),
    /DISCORD_GITHUB_PULL_CHANNEL_ID, DISCORD_GITHUB_ISSUE_CHANNEL_ID/,
  );
  assert.throws(
    () => loadConfig({ ...githubEnv, DISCORD_GITHUB_PULL_ROLE_ID: "" }),
    /Missing DISCORD_GITHUB_PULL_ROLE_ID/,
  );
});

test("startup identifies conflicting channel and role settings without including their values", () => {
  assert.throws(
    () =>
      loadConfig({
        ...githubEnv,
        DISCORD_SUPPORT_SOURCE_IDS: `${source},${welcome}`,
        DISCORD_MODERATOR_ROLE_IDS: `${modRole},${guildId}`,
        DISCORD_CONTRIBUTOR_ROLE_ID: pullRole,
      }),
    {
      message: [
        "Discord settings in each group share an ID.",
        "- DISCORD_WELCOME_CHANNEL_ID, DISCORD_SUPPORT_SOURCE_IDS",
        "- DISCORD_GUILD_ID, DISCORD_MODERATOR_ROLE_IDS",
        "- DISCORD_GITHUB_PULL_ROLE_ID, DISCORD_CONTRIBUTOR_ROLE_ID",
      ].join("\n"),
    },
  );
});

function enqueueGitHubActivity(store: Store) {
  const repository = { full_name: config.repository };
  const issue = {
    number: 11,
    title: "Issue @everyone",
    user: { login: "contributor" },
  };
  assert.equal(
    acceptDelivery(
      store,
      config.repository,
      "issues",
      "7b68c995-85b5-43ce-af7e-7b669a6e3ab4",
      {
        repository,
        action: "opened",
        issue,
      },
    ),
    202,
  );
  assert.equal(
    acceptDelivery(
      store,
      config.repository,
      "pull_request",
      "7b68c995-85b5-43ce-af7e-7b669a6e3ab5",
      {
        repository,
        action: "opened",
        pull_request: { ...issue, number: 12, title: "Pull request" },
      },
    ),
    202,
  );
}

test("GitHub issues and pull requests reach their matching opt-in feeds without pings", async (t) => {
  const { store, guild, operations } = setup();
  t.after(() => store.close());
  enqueueGitHubActivity(store);
  await drainJobs(guild, config, store);
  assert.deepEqual(
    operations.map(({ channel }) => channel),
    [issueChannel, pullChannel],
  );
  for (const [index, { message }] of operations.entries()) {
    assert.deepEqual(message.allowedMentions?.parse, []);
    assert.equal(message.flags, MessageFlags.SuppressNotifications);
    const embed = message.embeds?.[0];
    assert.ok(embed && "toJSON" in embed);
    assert.equal(
      embed.toJSON().url,
      `https://github.com/PrintBench/printbench/${index === 0 ? "issues/11" : "pull/12"}`,
    );
  }
});

test("Benchy refuses a GitHub feed whose permissions let the other opt-in role view it", async (t) => {
  const { store, guild, operations } = setup({ crossFeedAccess: true });
  t.after(() => store.close());
  enqueueGitHubActivity(store);
  await drainJobs(guild, config, store);
  assert.deepEqual(
    operations.map(({ channel }) => channel),
    [pullChannel],
  );
  assert.deepEqual(
    store.status().failed.map(({ id }) => id),
    [`github:printbench/printbench:issue:11`],
  );
});
