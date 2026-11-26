import { createHash } from "node:crypto";
import {
  ChannelType,
  EmbedBuilder,
  escapeMarkdown,
  MessageFlags,
  PermissionFlagsBits,
} from "discord.js";
import type {
  Guild,
  GuildMember,
  GuildTextBasedChannel,
  Message,
  MessageCreateOptions,
} from "discord.js";
import type { Config } from "./config.js";
import {
  channelOverwrites,
  coversSupportAudience,
  isRoleGated,
} from "./permissions.js";
import { errorDetails, log } from "./log.js";
import type { Ban, Job, Store } from "./store.js";

export const quiet = { parse: [], repliedUser: false } as const;
const {
  ViewChannel,
  SendMessages,
  SendMessagesInThreads,
  ReadMessageHistory,
  EmbedLinks,
  BanMembers,
  MentionEveryone,
  ManageThreads,
} = PermissionFlagsBits;

export class UserError extends Error {}

export class DiscordSetupError extends UserError {
  constructor(
    readonly step: string,
    hint: string,
    cause: unknown,
  ) {
    super(hint, { cause });
  }
}

export function discordStatus(error: unknown) {
  return typeof error === "object" && error !== null && "status" in error
    ? (error.status as number)
    : undefined;
}

export function discordCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined;
}

export async function checkDiscordSetup<T>(
  step: string,
  hint: string,
  request: () => Promise<T>,
) {
  try {
    return await request();
  } catch (error) {
    const code = discordCode(error);
    if (code === 50001 || code === 50013 || code === 10003 || code === 10004)
      throw new DiscordSetupError(step, hint, error);
    throw error;
  }
}

export function member(guild: Guild, id: string) {
  return guild.members.fetch({ user: id, force: true, cache: false });
}

export function assertBotPermissions(
  channel: {
    permissionsFor(
      member: GuildMember,
    ): { has(permissions: bigint[]): boolean } | null;
    id: string;
  },
  bot: GuildMember,
  permissions: bigint[],
) {
  if (!channel.permissionsFor(bot)?.has(permissions)) {
    throw new UserError(
      `Benchy is missing permissions in channel ${channel.id}.`,
    );
  }
}

export async function textChannel(guild: Guild, id: string) {
  const channel = await guild.channels.fetch(id, { force: true });
  if (
    !channel ||
    (channel.type !== ChannelType.GuildText &&
      channel.type !== ChannelType.GuildAnnouncement)
  ) {
    throw new UserError(
      `Channel ${id} must be a text or announcements channel.`,
    );
  }
  return channel;
}

export async function supportForum(guild: Guild, id: string) {
  const forum = await guild.channels.fetch(id, { force: true });
  if (forum?.type !== ChannelType.GuildForum)
    throw new UserError(`Channel ${id} must be a forum.`);
  return forum;
}

export function isSolvedTag(tag: { name: string }) {
  return tag.name.trim().toLowerCase() === "solved";
}

export function initialSupportTag(
  forum: Awaited<ReturnType<typeof supportForum>>,
) {
  return forum.availableTags.find((tag) => !tag.moderated && !isSolvedTag(tag));
}

export async function staffChannel(
  guild: Guild,
  config: Config,
  kind: keyof Config["github"] | "audit",
) {
  const feed = kind === "audit" ? undefined : config.github[kind];
  const channel = await textChannel(guild, feed?.channel ?? config.audit);
  const botRole = guild.members.me?.roles.botRole?.id;
  const roles = botRole
    ? [...config.moderators, botRole]
    : [...config.moderators];
  const optIn = feed?.role;
  if (optIn) roles.push(optIn);
  if (!isRoleGated(guild.id, channelOverwrites(channel), roles, optIn)) {
    throw new UserError(`Channel ${channel.id} needs private role overwrites.`);
  }
  return channel;
}

export async function validateGuild(guild: Guild, config: Config) {
  const bot = await checkDiscordSetup(
    "fetch_bot_membership",
    "Check that the Discord application for DISCORD_TOKEN is installed on the server named by DISCORD_GUILD_ID.",
    () => guild.members.fetchMe({ force: true }),
  );
  await checkDiscordSetup(
    "fetch_server_roles",
    "Check DISCORD_GUILD_ID and verify that Benchy is still a member of that server.",
    () => guild.roles.fetch(),
  );
  for (const id of [
    config.releaseRole,
    config.github.pull.role,
    config.github.issue.role,
    ...config.moderators,
  ]) {
    if (!guild.roles.cache.has(id))
      throw new UserError(`Discord role ${id} is missing.`);
  }
  if (!bot.permissions.has(BanMembers))
    throw new UserError("Benchy needs Ban Members.");
  function checkChannel<T>(
    setting: string,
    id: string,
    request: () => Promise<T>,
  ) {
    return checkDiscordSetup(
      setting,
      `Check that channel ${id} is on the configured server and grant the Benchy role View Channel there.`,
      request,
    );
  }
  const [releases, pulls, issues, audit, welcome, forum] = await Promise.all([
    checkChannel("DISCORD_RELEASES_CHANNEL_ID", config.releases, () =>
      textChannel(guild, config.releases),
    ),
    checkChannel(
      "DISCORD_GITHUB_PULL_CHANNEL_ID",
      config.github.pull.channel,
      () => staffChannel(guild, config, "pull"),
    ),
    checkChannel(
      "DISCORD_GITHUB_ISSUE_CHANNEL_ID",
      config.github.issue.channel,
      () => staffChannel(guild, config, "issue"),
    ),
    checkChannel("DISCORD_MOD_LOG_CHANNEL_ID", config.audit, () =>
      staffChannel(guild, config, "audit"),
    ),
    checkChannel("DISCORD_WELCOME_CHANNEL_ID", config.welcome, () =>
      textChannel(guild, config.welcome),
    ),
    checkChannel("DISCORD_SUPPORT_FORUM_ID", config.support, () =>
      supportForum(guild, config.support),
    ),
    checkChannel("DISCORD_RULES_CHANNEL_ID", config.rules, () =>
      textChannel(guild, config.rules),
    ),
  ]);
  const publishing = [
    ViewChannel,
    SendMessages,
    ReadMessageHistory,
    EmbedLinks,
  ];
  for (const channel of [releases, pulls, issues, audit, welcome])
    assertBotPermissions(channel, bot, publishing);
  if (!guild.roles.cache.get(config.releaseRole)?.mentionable) {
    assertBotPermissions(releases, bot, [MentionEveryone]);
  }

  assertBotPermissions(forum, bot, [
    ViewChannel,
    SendMessages,
    ReadMessageHistory,
    ManageThreads,
  ]);
  if (forum.flags.has("RequireTag") && !initialSupportTag(forum)) {
    throw new UserError(
      "The Support forum needs an available non-moderated tag or optional tags.",
    );
  }
  const sources = await Promise.all(
    config.sources.map((id) =>
      checkChannel("DISCORD_SUPPORT_SOURCE_IDS", id, () =>
        textChannel(guild, id),
      ),
    ),
  );
  for (const source of sources) {
    assertBotPermissions(source, bot, publishing);
    if (
      source.type !== ChannelType.GuildText ||
      source.flags.has("IsSpoilerChannel") ||
      source.nsfw !== forum.nsfw ||
      !coversSupportAudience(
        guild.roles.everyone.permissions.bitfield,
        guild.id,
        channelOverwrites(source),
        channelOverwrites(forum),
      )
    ) {
      throw new UserError(
        `Support cannot safely route from channel ${source.id}.`,
      );
    }
  }
}

export function banReason(ban: Ban) {
  return `Benchy ${ban.id} | Moderator ${ban.moderator} | ${ban.reason.toWellFormed()}`;
}

export async function currentBan(guild: Guild, user: string) {
  try {
    return await guild.bans.fetch({ user, force: true, cache: false });
  } catch (error) {
    if (discordCode(error) !== 10026) throw error;
    return null;
  }
}

function bounded(text: string, size: number) {
  return text.length <= size ? text : `${text.slice(0, size - 1).trimEnd()}…`;
}

type Announcement = {
  embed: EmbedBuilder;
  content?: string;
  flags?: MessageCreateOptions["flags"];
  reply?: MessageCreateOptions["reply"];
  users?: string[];
  roles?: string[];
};

function announcement(config: Config, job: Job): Announcement {
  switch (job.kind) {
    case "release": {
      const { release } = job;
      const tag = bounded(escapeMarkdown(release.tag), 150);
      const base = `https://github.com/${config.repository}/releases`;
      const path = encodeURIComponent(release.tag);
      const releaseUrl = `${base}/tag/${path}`;
      const downloadUrl = `${base}/download/${path}/compose.yaml`;
      const embed = new EmbedBuilder()
        .setColor(release.prerelease ? 0x997242 : 0x287d61)
        .setTitle(
          `PrintBench ${tag}${release.prerelease ? " · Prerelease" : ""}`,
        )
        .setURL(releaseUrl)
        .setDescription(
          [
            release.summary
              ? bounded(escapeMarkdown(release.summary), 1200)
              : "",
            `[Release notes](${releaseUrl}) · [Download Compose file](${downloadUrl})`,
          ]
            .filter(Boolean)
            .join("\n\n"),
        )
        .setTimestamp(new Date(release.published));
      return {
        embed,
        content: release.prerelease ? undefined : `<@&${config.releaseRole}>`,
        roles: release.prerelease ? [] : [config.releaseRole],
        flags: release.prerelease
          ? MessageFlags.SuppressNotifications
          : undefined,
      };
    }
    case "activity": {
      const pull = job.event === "pull";
      const embed = new EmbedBuilder()
        .setColor(pull ? 0x6e54c2 : 0x287d61)
        .setTitle(
          bounded(
            `${pull ? "Pull request" : "Issue"} #${job.number} · ${escapeMarkdown(job.title)}`,
            256,
          ),
        )
        .setURL(
          `https://github.com/${config.repository}/${pull ? "pull" : "issues"}/${job.number}`,
        )
        .setDescription(
          `Opened by **${escapeMarkdown(job.author)}** in ${config.repository}`,
        );
      return { embed, flags: MessageFlags.SuppressNotifications };
    }
    case "welcome":
      return {
        content: `Welcome, <@${job.member}>!`,
        users: [job.member],
        embed: new EmbedBuilder().setDescription(
          `Start with <#${config.rules}> and ask technical questions in <#${config.support}>. Use \`/info\` for PrintBench links.`,
        ),
      };
    case "audit":
      return {
        embed: new EmbedBuilder()
          .setTitle("Member banned")
          .addFields(
            {
              name: "Moderator",
              value: `<@${job.ban.moderator}> (\`${job.ban.moderator}\`)`,
            },
            {
              name: "Target",
              value: `<@${job.ban.target}> (\`${job.ban.target}\`)`,
            },
            { name: "Reason", value: escapeMarkdown(job.ban.reason) },
          )
          .setTimestamp(new Date(job.ban.created)),
      };
    case "member-audit": {
      const entry = job.entry;
      const title = {
        kick: "Member kicked",
        timeout: "Member timed out",
        untimeout: "Member timeout removed",
        contributor: "Contributor role granted",
      }[entry.action];
      const embed = new EmbedBuilder()
        .setTitle(title)
        .addFields(
          {
            name: "Requested by",
            value: `<@${entry.moderator}> (\`${entry.moderator}\`)`,
          },
          { name: "Member", value: `<@${entry.target}> (\`${entry.target}\`)` },
          { name: "Reason", value: escapeMarkdown(entry.reason) },
        )
        .setTimestamp(new Date(entry.created));
      if (entry.until)
        embed.addFields({
          name: "Ends",
          value: `<t:${Math.floor(entry.until / 1000)}:F>`,
        });
      if (entry.evidence)
        embed.addFields({
          name: "GitHub contribution",
          value: `<${entry.evidence}>`,
        });
      return { embed };
    }
    case "redirect":
      return {
        embed: new EmbedBuilder().setDescription(
          `Continue this question in [the Support post](https://discord.com/channels/${config.guild}/${job.thread}).`,
        ),
        reply: { messageReference: job.message, failIfNotExists: true },
      };
  }
}

export async function findRecentMessage(
  channel: GuildTextBasedChannel,
  since: number,
  matches: (message: Message) => boolean,
) {
  let before: string | undefined;
  for (;;) {
    const messages = await channel.messages.fetch({
      limit: 100,
      before,
      cache: false,
    });
    const threshold = since - 5_000;
    const existing = messages.find(matches);
    if (existing) return existing;
    const oldest = messages.last();
    if (!oldest || messages.size < 100 || oldest.createdTimestamp < threshold)
      return null;
    before = oldest.id;
  }
}

export async function drainJobs(guild: Guild, config: Config, store: Store) {
  for (const row of store.nextJobs()) {
    const { job } = row;
    try {
      let channel: GuildTextBasedChannel;
      switch (job.kind) {
        case "welcome": {
          const author = await member(guild, job.member).catch((error) => {
            if (discordCode(error) !== 10007) throw error;
            return null;
          });
          if (
            !author ||
            author.pending ||
            author.user.bot ||
            author.joinedTimestamp !== job.joined
          ) {
            store.sent(row.id, "member no longer eligible");
            continue;
          }
          channel = await textChannel(guild, config.welcome);
          break;
        }
        case "audit":
        case "member-audit":
        case "activity":
          channel = await staffChannel(
            guild,
            config,
            job.kind === "activity" ? job.event : "audit",
          );
          break;
        case "release":
          channel = await textChannel(guild, config.releases);
          if (!job.release.prerelease) {
            const role = await guild.roles.fetch(config.releaseRole, {
              force: true,
            });
            if (!role)
              throw new UserError(
                "The configured Release Pings role is missing.",
              );
            if (!role.mentionable)
              assertBotPermissions(channel, guild.members.me!, [
                MentionEveryone,
              ]);
          }
          break;
        case "redirect":
          channel = await textChannel(guild, job.source);
          break;
      }

      // Discord enforces a short nonce window. The footer also lets us recover a
      // successful send after a longer restart or an ambiguous network failure.
      const nonce = createHash("sha256")
        .update(row.id)
        .digest("hex")
        .slice(0, 24);
      const marker = `Benchy • ${nonce}`;
      if (row.first_attempt !== null) {
        const existing = await findRecentMessage(
          channel,
          row.first_attempt,
          (message) =>
            message.author.id === guild.client.user.id &&
            message.embeds.some((embed) => embed.footer?.text === marker),
        );
        if (existing) {
          store.sent(row.id, existing.id);
          continue;
        }
      }
      const { embed, content, roles, flags, users, reply } = announcement(
        config,
        job,
      );
      store.startJob(row.id);
      const posted = await channel.send({
        content,
        flags,
        reply,
        nonce,
        enforceNonce: true,
        embeds: [embed.setFooter({ text: marker })],
        allowedMentions: { parse: [], repliedUser: false, users, roles },
      });
      store.sent(row.id, posted.id);
      log("info", "delivered", { id: row.id, message: posted.id });
    } catch (error) {
      const details = errorDetails(error);
      const status = discordStatus(error);
      const result = JSON.stringify({
        ...details,
        ...(error instanceof UserError ? { message: error.message } : {}),
      });
      if (
        row.attempts >= 11 ||
        error instanceof UserError ||
        (status !== undefined &&
          status >= 400 &&
          status < 500 &&
          status !== 429)
      ) {
        store.fail(row.id, result);
        log("error", "delivery_failed", { id: row.id, ...details });
      } else {
        const delay = Math.min(15 * 60_000, 5_000 * 2 ** row.attempts);
        store.retry(row.id, result, Date.now() + delay);
        log("error", "delivery_retry", { id: row.id, delay, ...details });
      }
    }
  }
}

export async function reconcileMemberEvents(guild: Guild, store: Store) {
  for (const ban of store.pendingBans(Date.now() - 60_000)) {
    try {
      const actual = await currentBan(guild, ban.target);
      if (actual?.reason === banReason(ban)) {
        store.completeBan(ban);
      } else if (ban.created < Date.now() - 5 * 60_000) {
        store.clearBan(ban.id);
        log("error", "ban_could_not_be_confirmed", {
          id: ban.id,
          target: ban.target,
        });
      }
    } catch (error) {
      log("error", "ban_reconcile_failed", {
        id: ban.id,
        ...errorDetails(error),
      });
    }
  }

  for (const { member: id, joined } of store.screeningMembers()) {
    try {
      const checked = await member(guild, id);
      if (checked.joinedTimestamp !== joined || checked.user.bot)
        store.forgetScreening(id, joined);
      else if (!checked.pending) store.welcome(id, joined);
    } catch (error) {
      if (discordCode(error) === 10007) store.forgetScreening(id, joined);
      else
        log("error", "screening_check_failed", { id, ...errorDetails(error) });
    }
  }
}
