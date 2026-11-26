import {
  ActionRowBuilder,
  ApplicationCommandType,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ContextMenuCommandBuilder,
  EmbedBuilder,
  escapeMarkdown,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import type {
  AnyThreadChannel,
  ButtonInteraction,
  ChatInputCommandInteraction,
  Guild,
  GuildMember,
  MessageContextMenuCommandInteraction,
  ModalSubmitInteraction,
} from "discord.js";
import { Actions } from "./actions.js";
import { project } from "./config.js";
import type { Config } from "./config.js";
import { contributionUrl, grantContributor } from "./contributors.js";
import type { contributorClaims } from "./contributors.js";
import {
  assertBotPermissions,
  banReason,
  currentBan,
  discordCode,
  discordStatus,
  initialSupportTag,
  isSolvedTag,
  member,
  quiet,
  staffChannel,
  supportForum,
  textChannel,
  UserError,
} from "./discord.js";
import { errorDetails, log } from "./log.js";
import { embedColors, linkButtons, printBenchLogo } from "./embeds.js";
import { channelOverwrites, coversSupportAudience } from "./permissions.js";
import { rulesCommands, setupCommand } from "./rules.js";
import type { Ban, Store } from "./store.js";

const {
  Administrator,
  BanMembers,
  KickMembers,
  ModerateMembers,
  ManageMessages,
  ManageRoles,
  ManageThreads,
  SendMessages,
  SendMessagesInThreads,
  ViewChannel,
  EmbedLinks,
  ReadMessageHistory,
} = PermissionFlagsBits;

const moderation = {
  ban: {
    permission: BanMembers,
    label: "Ban",
    description: "Ban a member and record the reason",
    done: "Member banned.",
  },
  kick: {
    permission: KickMembers,
    label: "Kick",
    description: "Kick a member and record the reason",
    done: "Member kicked.",
  },
  timeout: {
    permission: ModerateMembers,
    label: "Timeout",
    description: "Temporarily prevent a member from participating",
    done: "Member timed out.",
  },
  untimeout: {
    permission: ModerateMembers,
    label: "Remove timeout",
    description: "Remove a member's timeout",
    done: "Member timeout removed.",
  },
} as const;

type Action = keyof typeof moderation;
type PendingAction = Ban & { action: Action; minutes?: number };
const maxTimeoutMinutes = 28 * 24 * 60;

function moderationCommand(action: Action) {
  const details = moderation[action];
  const builder = new SlashCommandBuilder()
    .setName(action)
    .setDescription(details.description)
    .setDefaultMemberPermissions(details.permission);
  builder.addUserOption((option) =>
    option
      .setName("member")
      .setDescription("Member to moderate")
      .setRequired(true),
  );
  if (action === "timeout")
    builder.addIntegerOption((option) =>
      option
        .setName("minutes")
        .setDescription("Timeout duration in minutes (up to 28 days)")
        .setMinValue(1)
        .setMaxValue(maxTimeoutMinutes)
        .setRequired(true),
    );
  return builder.addStringOption((option) =>
    option
      .setName("reason")
      .setDescription("Reason for the moderation log")
      .setRequired(true)
      .setMaxLength(300),
  );
}

export const commands = [
  setupCommand,
  new SlashCommandBuilder()
    .setName("info")
    .setDescription("Share the official PrintBench links"),
  moderationCommand("ban"),
  moderationCommand("kick"),
  moderationCommand("timeout"),
  moderationCommand("untimeout"),
  new SlashCommandBuilder()
    .setName("resolve")
    .setDescription("Set or clear the Solved tag on this Support post")
    .setDefaultMemberPermissions(ManageThreads)
    .addBooleanOption((option) =>
      option
        .setName("solved")
        .setDescription("Set to false to clear the Solved tag"),
    ),
  new SlashCommandBuilder()
    .setName("contributor")
    .setDescription("Recognize PrintBench contributors")
    .addSubcommand((subcommand) =>
      subcommand
        .setName("claim")
        .setDescription(
          "Claim Contributor using a verified GitHub connection and a merged pull request",
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("grant")
        .setDescription(
          "Grant Contributor for a verified contribution (moderators only)",
        )
        .addUserOption((option) =>
          option
            .setName("member")
            .setDescription("Member who contributed")
            .setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName("evidence")
            .setDescription("Link to the contribution on GitHub")
            .setRequired(true)
            .setMaxLength(450),
        )
        .addStringOption((option) =>
          option
            .setName("reason")
            .setDescription("Context for the private moderation log")
            .setMaxLength(300),
        ),
    ),
  new SlashCommandBuilder()
    .setName("lock")
    .setDescription("Lock and archive this forum post")
    .setDefaultMemberPermissions(ManageThreads),
  new SlashCommandBuilder()
    .setName("unlock")
    .setDescription("Unlock and reopen this forum post")
    .setDefaultMemberPermissions(ManageThreads)
    .addStringOption((option) =>
      option
        .setName("post")
        .setDescription(
          "Forum post link or ID when running this outside the post",
        )
        .setMaxLength(150),
    ),
  new ContextMenuCommandBuilder()
    .setName("Send to Support")
    .setType(ApplicationCommandType.Message)
    .setDefaultMemberPermissions(ManageMessages),
].map((command) => command.toJSON());

type Selected = {
  moderator: string;
  author: string;
  source: string;
  message: string;
  content: string;
  edited: number | null;
  attachments: boolean;
};

function requireMod(config: Config, moderator: GuildMember) {
  if (
    moderator.id !== moderator.guild.ownerId &&
    !config.moderators.some((role) => moderator.roles.cache.has(role))
  ) {
    throw new UserError("Only PrintBench moderators can use this action.");
  }
}

function canModerate(
  action: Action,
  bot: GuildMember,
  moderator: GuildMember,
  target: GuildMember,
) {
  const owner = moderator.guild.ownerId;
  const permission = moderation[action].permission;
  return (
    moderator.permissions.has(permission) &&
    target.id !== owner &&
    target.id !== bot.id &&
    target.id !== moderator.id &&
    (moderator.id === owner ||
      moderator.roles.highest.comparePositionTo(target.roles.highest) > 0) &&
    bot.permissions.has(permission) &&
    bot.roles.highest.comparePositionTo(target.roles.highest) > 0 &&
    (permission !== ModerateMembers ||
      (!target.permissions.has(Administrator) && !target.user.bot))
  );
}

function info() {
  return {
    embeds: [
      new EmbedBuilder()
        .setColor(embedColors.printBench)
        .setTitle("PrintBench")
        .setDescription(
          "Organise your 3D print files in one self-hosted library.",
        )
        .setThumbnail(printBenchLogo),
    ],
    components: [
      linkButtons(
        ["Website", project.website],
        ["Documentation", project.docs],
        ["GitHub", project.github],
      ),
      linkButtons(
        ["Latest release", project.releases],
        ["Download Compose file", project.download],
      ),
    ],
  };
}

function messageLink(guild: string, source: string, message: string) {
  return `https://discord.com/channels/${guild}/${source}/${message}`;
}

function postId(value: string, guild: string) {
  const text = value.trim();
  if (/^\d{17,20}$/.test(text)) return text;
  const link =
    /^https:\/\/discord\.com\/channels\/(\d{17,20})\/(\d{17,20})(?:\/\d{17,20})?(?:\?[^\s]*)?$/.exec(
      text,
    );
  if (link?.[1] === guild) return link[2];
  throw new UserError("Enter a forum post link or ID from this server.");
}

async function recoverSupportThread(
  forum: Awaited<ReturnType<typeof supportForum>>,
  bot: string,
  created: number,
  original: string,
) {
  const find = async (threads: Iterable<AnyThreadChannel>) => {
    for (const thread of threads) {
      if (
        thread.ownerId !== bot ||
        (thread.createdTimestamp ?? 0) < created - 5_000
      )
        continue;
      const starter = await thread
        .fetchStarterMessage({ cache: false })
        .catch((error) => {
          if (discordCode(error) !== 10008) throw error;
          return null;
        });
      if (starter?.content.startsWith(`Original message: <${original}>`))
        return thread;
    }
    return null;
  };

  const active = await forum.threads.fetchActive(false);
  const existing = await find(active.threads.values());
  if (existing) return existing;

  let before: Date | undefined;
  for (;;) {
    const archived = await forum.threads.fetchArchived(
      { before, type: "public", limit: 100 },
      false,
    );
    const existingArchive = await find(archived.threads.values());
    if (existingArchive) return existingArchive;
    const oldest = archived.threads.last()?.archiveTimestamp;
    if (
      !archived.hasMore ||
      !oldest ||
      oldest < created - 5_000 ||
      (before && oldest >= +before)
    )
      return null;
    before = new Date(oldest);
  }
}

export function commandHandlers(
  config: Config,
  store: Store,
  claims?: ReturnType<typeof contributorClaims>,
) {
  const selections = new Actions<Selected>();
  const confirmations = new Actions<PendingAction>();
  const creatingSupport = new Set<string>();
  const rules = rulesCommands(config, store);

  async function beginSupport(
    interaction: MessageContextMenuCommandInteraction<"cached">,
  ) {
    requireMod(config, interaction.member);
    if (
      !interaction.memberPermissions.has(ManageMessages) ||
      !config.sources.includes(interaction.channelId)
    ) {
      throw new UserError(
        "Use this action in a configured Support source channel where you can manage messages.",
      );
    }
    const selected = interaction.targetMessage;
    if (
      selected.channelId !== interaction.channelId ||
      selected.system ||
      selected.author.bot
    )
      throw new UserError("Select a message from a community member.");

    selections.add(interaction.id, {
      moderator: interaction.user.id,
      author: selected.author.id,
      source: selected.channelId,
      message: selected.id,
      content: selected.content,
      edited: selected.editedTimestamp,
      attachments: selected.attachments.size > 0,
    });
    await interaction.showModal(
      new ModalBuilder()
        .setCustomId(`support:${interaction.id}`)
        .setTitle("Send to Support")
        .addLabelComponents((label) =>
          label
            .setLabel("Support post title")
            .setTextInputComponent(
              new TextInputBuilder()
                .setCustomId("title")
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setMinLength(1)
                .setMaxLength(100),
            ),
        ),
    );
  }

  async function finishSupport(
    interaction: ModalSubmitInteraction<"cached">,
    id: string,
  ) {
    const selected = selections.get(id);
    if (!selected || selected.moderator !== interaction.user.id)
      throw new UserError("This Support form has expired.");
    selections.remove(id);
    const title = interaction.fields.getTextInputValue("title").trim();
    if (!title) throw new UserError("Enter a title for the Support post.");
    if (creatingSupport.has(selected.message))
      throw new UserError("A moderator is already routing this message.");
    creatingSupport.add(selected.message);
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const guild = interaction.guild;
      const [source, forum, moderator, author] = await Promise.all([
        textChannel(guild, selected.source),
        supportForum(guild, config.support),
        member(guild, interaction.user.id),
        member(guild, selected.author),
      ]);
      requireMod(config, moderator);
      if (
        source.type !== ChannelType.GuildText ||
        source.flags.has("IsSpoilerChannel") ||
        !source.permissionsFor(moderator).has([ViewChannel, ManageMessages]) ||
        source.nsfw !== forum.nsfw ||
        !coversSupportAudience(
          guild.roles.everyone.permissions.bitfield,
          guild.id,
          channelOverwrites(source),
          channelOverwrites(forum),
        )
      ) {
        throw new UserError(
          "This source channel does not safely cover the Support audience.",
        );
      }
      if (
        author.pending ||
        author.isCommunicationDisabled() ||
        !forum.permissionsFor(author).has([ViewChannel, SendMessagesInThreads])
      ) {
        throw new UserError(
          "The author needs access to reply in the Support forum.",
        );
      }
      const bot = guild.members.me!;
      assertBotPermissions(source, bot, [
        ViewChannel,
        SendMessages,
        ReadMessageHistory,
        EmbedLinks,
      ]);
      assertBotPermissions(forum, bot, [
        ViewChannel,
        SendMessages,
        ReadMessageHistory,
      ]);
      const original = messageLink(guild.id, selected.source, selected.message);
      const earlier = store.route(selected.message);
      if (earlier) {
        const thread =
          earlier.thread ||
          (await recoverSupportThread(forum, bot.id, earlier.created, original))
            ?.id;
        if (!thread)
          throw new UserError(
            "A previous attempt is unresolved. Ask an administrator to check the Benchy deployment.",
          );
        if (!earlier.thread) store.completeRoute(selected.message, thread);
        await interaction.editReply({
          content: `Already routed to ${forumPost(guild, thread)}.`,
          allowedMentions: quiet,
        });
        return;
      }

      const latest = await source.messages
        .fetch({ message: selected.message, force: true, cache: false })
        .catch((error) => {
          if (discordCode(error) === 10008)
            throw new UserError("The original message was deleted.");
          throw error;
        });
      if (selected.edited !== latest.editedTimestamp) {
        throw new UserError(
          "The original message changed. Open Send to Support again to use the latest version.",
        );
      }
      const escaped = escapeMarkdown(selected.content.trim());
      const excerpt =
        escaped.length > 1450 ? `${escaped.slice(0, 1449)}…` : escaped;
      const body = [
        `Original message: <${original}>`,
        `From <@${author.id}>`,
        excerpt,
        selected.attachments
          ? "Attachments are available on the original message."
          : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      const tag = forum.flags.has("RequireTag")
        ? initialSupportTag(forum)
        : undefined;
      if (forum.flags.has("RequireTag") && !tag)
        throw new UserError("The Support forum needs an available tag.");
      if (!store.reserveRoute(source.id, selected.message)) {
        throw new UserError(
          "Another moderator is already routing this message.",
        );
      }
      let thread;
      try {
        thread = await forum.threads.create({
          name: title,
          message: { content: body, allowedMentions: quiet },
          appliedTags: tag ? [tag.id] : undefined,
          reason: `Routed by ${moderator.id}`,
        });
      } catch (error) {
        const status = discordStatus(error);
        if (status && status >= 400 && status < 500 && status !== 429)
          store.clearRoute(selected.message);
        throw error;
      }
      store.completeRoute(selected.message, thread.id);
      await interaction.editReply({
        content: `Created ${forumPost(guild, thread.id)} and queued a redirect.`,
        allowedMentions: quiet,
      });
    } finally {
      creatingSupport.delete(selected.message);
    }
  }

  async function beginModeration(
    interaction: ChatInputCommandInteraction<"cached">,
    action: Action,
  ) {
    requireMod(config, interaction.member);
    const { permission, label } = moderation[action];
    if (!interaction.memberPermissions.has(permission))
      throw new UserError(
        `You do not have Discord permission to ${label.toLowerCase()} a member.`,
      );
    const reason = interaction.options.getString("reason", true).trim();
    if (!reason) throw new UserError("Enter a reason for the moderation log.");
    const minutes =
      action === "timeout"
        ? interaction.options.getInteger("minutes", true)
        : undefined;
    if (
      minutes !== undefined &&
      (!Number.isInteger(minutes) || minutes < 1 || minutes > maxTimeoutMinutes)
    )
      throw new UserError("Choose a timeout between one minute and 28 days.");
    const target = interaction.options.getUser("member", true);
    const pending: PendingAction = {
      id: interaction.id,
      moderator: interaction.user.id,
      target: target.id,
      reason,
      created: Date.now(),
      action,
      minutes,
    };
    confirmations.add(pending.id, pending);
    const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Danger)
        .setLabel("Confirm")
        .setCustomId(`${action}-confirm:${pending.id}`),
      new ButtonBuilder()
        .setStyle(ButtonStyle.Secondary)
        .setLabel("Cancel")
        .setCustomId(`${action}-cancel:${pending.id}`),
    );
    await interaction.reply({
      content: `${label} <@${target.id}> (\`${target.id}\`)${minutes ? ` for ${minutes} minutes` : ""}?\nReason: ${escapeMarkdown(reason)}`,
      components: [buttons],
      flags: MessageFlags.Ephemeral,
      allowedMentions: quiet,
    });
  }

  async function finishModeration(
    interaction: ButtonInteraction<"cached">,
    id: string,
    action: Action,
    confirm: boolean,
  ) {
    const pending = confirmations.get(id);
    if (
      !pending ||
      pending.action !== action ||
      pending.moderator !== interaction.user.id
    )
      throw new UserError("This moderation confirmation has expired.");
    confirmations.remove(id);
    if (!confirm) {
      await interaction.update({
        content: `${moderation[action].label} cancelled.`,
        components: [],
      });
      return;
    }
    await interaction.deferUpdate();
    const guild = interaction.guild;
    const [moderator, target, bot, audit] = await Promise.all([
      member(guild, pending.moderator),
      member(guild, pending.target).catch((error) => {
        if (discordCode(error) === 10007)
          throw new UserError("The target is no longer a guild member.");
        throw error;
      }),
      guild.members.fetchMe({ force: true }),
      staffChannel(guild, config, "audit"),
      guild.roles.fetch(),
    ]);
    requireMod(config, moderator);
    if (!canModerate(action, bot, moderator, target))
      throw new UserError(
        "You or Benchy cannot moderate that member. Check Discord permissions and the role hierarchy.",
      );
    assertBotPermissions(audit, bot, [
      ViewChannel,
      SendMessages,
      ReadMessageHistory,
      EmbedLinks,
    ]);
    if (action !== "ban") {
      const reason = `Benchy | Moderator ${pending.moderator} | ${pending.reason.toWellFormed()}`;
      const created = Date.now();
      const until =
        pending.minutes === undefined
          ? undefined
          : created + pending.minutes * 60_000;
      if (action === "kick") await target.kick(reason);
      else await target.disableCommunicationUntil(until ?? null, reason);
      store.recordMemberAudit(id, {
        action,
        moderator: pending.moderator,
        target: pending.target,
        reason: pending.reason,
        created,
        until,
      });
      await interaction.editReply({
        content: `${moderation[action].done} The audit entry is queued.`,
        components: [],
      });
      return;
    }
    if (await currentBan(guild, target.id))
      throw new UserError("That member is already banned.");
    const ban: Ban = {
      id,
      moderator: pending.moderator,
      target: pending.target,
      reason: pending.reason,
      created: Date.now(),
    };
    if (!store.reserveBan(ban))
      throw new UserError(
        "Benchy is already processing a ban for this member.",
      );
    try {
      await guild.bans.create(ban.target, {
        deleteMessageSeconds: 0,
        reason: banReason(ban),
      });
    } catch (error) {
      const status = discordStatus(error);
      if (status && status >= 400 && status < 500 && status !== 429) {
        store.clearBan(ban.id);
        throw error;
      }
      log("error", "ban_response_uncertain", {
        id: ban.id,
        ...errorDetails(error),
      });
      throw new UserError(
        "Discord did not confirm the ban. Benchy will check the result before posting an audit.",
      );
    }
    store.completeBan(ban);
    await interaction.editReply({
      content: "Member banned. The audit entry is queued.",
      components: [],
    });
  }

  async function moderatedPost(
    interaction: ChatInputCommandInteraction<"cached">,
    channelId: string,
  ) {
    const guild = interaction.guild;
    const [channel, moderator] = await Promise.all([
      guild.channels.fetch(channelId, { force: true }),
      member(guild, interaction.user.id),
    ]);
    requireMod(config, moderator);
    if (!channel?.isThread() || !channel.parentId)
      throw new UserError("Run this inside a forum post.");
    const parent = await guild.channels.fetch(channel.parentId, {
      force: true,
    });
    if (parent?.type !== ChannelType.GuildForum)
      throw new UserError("Run this inside a forum post.");
    if (!channel.permissionsFor(moderator)?.has([ViewChannel, ManageThreads])) {
      throw new UserError("You need Manage Threads in this forum.");
    }
    assertBotPermissions(channel, guild.members.me!, [
      ViewChannel,
      ManageThreads,
    ]);
    return { channel, parent, moderator };
  }

  async function setLock(
    interaction: ChatInputCommandInteraction<"cached">,
    locked: boolean,
  ) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const post = locked ? null : interaction.options.getString("post");
    const channelId =
      post === null
        ? interaction.channelId
        : postId(post, interaction.guild.id);
    const { channel, moderator } = await moderatedPost(interaction, channelId);
    if (channel.locked !== locked || channel.archived !== locked) {
      if (locked && channel.archived) await channel.setArchived(false);
      await channel.edit({
        locked,
        archived: locked,
        reason: `${locked ? "Locked" : "Reopened"} by ${moderator.id}`,
      });
    }
    await interaction.editReply(
      locked ? "Post locked and archived." : "Post reopened.",
    );
  }

  async function resolve(interaction: ChatInputCommandInteraction<"cached">) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const { channel, parent, moderator } = await moderatedPost(
      interaction,
      interaction.channelId,
    );
    if (parent.id !== config.support)
      throw new UserError("Run this in a post in the Support forum.");
    const tag = parent.availableTags.filter(isSolvedTag);
    if (tag.length !== 1)
      throw new UserError("The Support forum needs one tag named Solved.");
    const solved = interaction.options.getBoolean("solved") ?? true;
    const current = channel.appliedTags;
    if (current.includes(tag[0].id) !== solved) {
      if (channel.archived)
        throw new UserError(
          "Reopen the Support post before changing its tags.",
        );
      if (solved && current.length >= 5)
        throw new UserError(
          "Remove one existing tag before marking this post as solved.",
        );
      const tags = solved
        ? [...current, tag[0].id]
        : current.filter((id) => id !== tag[0].id);
      await channel.setAppliedTags(
        tags,
        `${solved ? "Marked solved" : "Cleared Solved tag"} by ${moderator.id}`,
      );
    }
    await interaction.editReply(
      solved ? "Support post marked as solved." : "Solved tag removed.",
    );
  }

  async function contributor(
    interaction: ChatInputCommandInteraction<"cached">,
  ) {
    if (!config.contributor)
      throw new UserError("The Contributor role has not been configured.");
    if (interaction.options.getSubcommand() === "claim") {
      if (!claims)
        throw new UserError(
          "Ask a PrintBench moderator to verify your contribution and grant the Contributor role.",
        );
      if (interaction.member.pending)
        throw new UserError(
          "Complete the server rules screening before claiming Contributor.",
        );
      const url = claims.start(
        interaction.user.id,
        interaction.applicationId,
        interaction.id,
      );
      const button = new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setURL(url)
        .setLabel("Verify with Discord");
      await interaction.reply({
        content:
          "Connect GitHub in your Discord Connections settings, then authorize Benchy to check that account for a merged pull request. This link is valid for up to five minutes.",
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(button),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    requireMod(config, interaction.member);
    if (!interaction.memberPermissions.has(ManageRoles))
      throw new UserError("You need Manage Roles to grant Contributor.");
    const evidence = contributionUrl(
      interaction.options.getString("evidence", true),
      config.repository.split("/")[0],
    );
    const reason =
      interaction.options.getString("reason")?.trim() ||
      "Contribution verified by a moderator";
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const moderator = await member(interaction.guild, interaction.user.id);
    requireMod(config, moderator);
    const granted = await grantContributor(interaction.guild, config, store, {
      id: interaction.id,
      target: interaction.options.getUser("member", true).id,
      moderator,
      reason,
      evidence: evidence.href,
    });
    await interaction.editReply(
      granted
        ? "Contributor role granted. The audit entry is queued."
        : "That member already has Contributor.",
    );
  }

  return async function handle(interaction: import("discord.js").Interaction) {
    if (!interaction.inCachedGuild() || interaction.guildId !== config.guild)
      return;
    try {
      if (interaction.isChatInputCommand()) {
        switch (interaction.commandName) {
          case "setup":
            await rules.open(interaction);
            break;
          case "info":
            await interaction.reply({
              ...info(),
              allowedMentions: quiet,
            });
            break;
          case "ban":
          case "kick":
          case "timeout":
          case "untimeout":
            await beginModeration(interaction, interaction.commandName);
            break;
          case "resolve":
            await resolve(interaction);
            break;
          case "contributor":
            await contributor(interaction);
            break;
          case "lock":
          case "unlock":
            await setLock(interaction, interaction.commandName === "lock");
            break;
        }
      } else if (
        interaction.isMessageContextMenuCommand() &&
        interaction.commandName === "Send to Support"
      ) {
        await beginSupport(interaction);
      } else if (
        interaction.isModalSubmit() &&
        interaction.customId.startsWith("rules:form:")
      ) {
        await rules.preview(interaction);
      } else if (
        interaction.isButton() &&
        interaction.customId.startsWith("rules:")
      ) {
        await rules.button(interaction);
      } else if (
        interaction.isModalSubmit() &&
        interaction.customId.startsWith("support:")
      ) {
        await finishSupport(
          interaction,
          interaction.customId.slice("support:".length),
        );
      } else if (interaction.isButton()) {
        const match =
          /^(ban|kick|timeout|untimeout)-(confirm|cancel):([\d]+)$/.exec(
            interaction.customId,
          );
        if (match) {
          await finishModeration(
            interaction,
            match[3],
            match[1] as Action,
            match[2] === "confirm",
          );
        }
      }
    } catch (error) {
      if (!(error instanceof UserError))
        log("error", "interaction_failed", {
          id: interaction.id,
          ...errorDetails(error),
        });
      const content =
        error instanceof UserError
          ? error.message
          : "Benchy could not complete the action. Check the deployment logs.";
      if (!interaction.isRepliable()) return;
      await (
        interaction.deferred || interaction.replied
          ? interaction.editReply({
              content,
              components: [],
              allowedMentions: quiet,
            })
          : interaction.reply({
              content,
              flags: MessageFlags.Ephemeral,
              allowedMentions: quiet,
            })
      ).catch((replyError) =>
        log("error", "interaction_reply_failed", errorDetails(replyError)),
      );
    }
  };
}

function forumPost(guild: Guild, thread: string) {
  return `[the Support post](https://discord.com/channels/${guild.id}/${thread})`;
}
