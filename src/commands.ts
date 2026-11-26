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
import { project } from "./config.js";
import type { Config } from "./config.js";
import {
  assertBotPermissions,
  banReason,
  currentBan,
  discordCode,
  discordStatus,
  member,
  quiet,
  staffChannel,
  supportForum,
  textChannel,
  UserError,
} from "./discord.js";
import { errorDetails, log } from "./log.js";
import { channelOverwrites, coversSupportAudience } from "./permissions.js";
import type { Ban, Store } from "./store.js";

const {
  BanMembers,
  ManageMessages,
  ManageThreads,
  SendMessages,
  SendMessagesInThreads,
  ViewChannel,
  EmbedLinks,
  ReadMessageHistory,
} = PermissionFlagsBits;

export const commands = [
  new SlashCommandBuilder()
    .setName("info")
    .setDescription("Share the official PrintBench links"),
  new SlashCommandBuilder()
    .setName("ban")
    .setDescription("Ban a member and record the reason")
    .setDefaultMemberPermissions(BanMembers)
    .addUserOption((option) =>
      option
        .setName("member")
        .setDescription("Member to ban")
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("reason")
        .setDescription("Reason for the moderation log")
        .setRequired(true)
        .setMaxLength(300),
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

class Actions<T> {
  private items = new Map<string, { action: T; expires: NodeJS.Timeout }>();

  add(id: string, action: T) {
    const expires = setTimeout(() => this.items.delete(id), 5 * 60_000);
    expires.unref();
    this.items.set(id, { action, expires });
  }

  get(id: string) {
    return this.items.get(id)?.action;
  }

  remove(id: string) {
    const item = this.items.get(id);
    if (item) clearTimeout(item.expires);
    this.items.delete(id);
  }
}

function requireMod(config: Config, moderator: GuildMember) {
  if (
    moderator.id !== moderator.guild.ownerId &&
    !config.moderators.some((role) => moderator.roles.cache.has(role))
  ) {
    throw new UserError("Only PrintBench moderators can use this action.");
  }
}

function canBan(bot: GuildMember, moderator: GuildMember, target: GuildMember) {
  const owner = moderator.guild.ownerId;
  return (
    moderator.permissions.has(BanMembers) &&
    target.id !== owner &&
    target.id !== bot.id &&
    target.id !== moderator.id &&
    (moderator.id === owner ||
      moderator.roles.highest.comparePositionTo(target.roles.highest) > 0) &&
    bot.permissions.has(BanMembers) &&
    bot.roles.highest.comparePositionTo(target.roles.highest) > 0
  );
}

function info() {
  return new EmbedBuilder()
    .setColor(0x287d61)
    .setTitle("PrintBench")
    .setURL(project.website)
    .setDescription(
      [
        `[Website](${project.website}) · [Documentation](${project.docs}) · [GitHub](${project.github})`,
        `[Latest release](${project.releases}) · [Download Compose file](${project.download})`,
      ].join("\n"),
    );
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

export function commandHandlers(config: Config, store: Store) {
  const selections = new Actions<Selected>();
  const confirmations = new Actions<Ban>();
  const creatingSupport = new Set<string>();

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
        ? forum.availableTags.find((entry) => !entry.moderated)
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

  async function beginBan(interaction: ChatInputCommandInteraction<"cached">) {
    requireMod(config, interaction.member);
    if (!interaction.memberPermissions.has(BanMembers))
      throw new UserError("You need Ban Members.");
    const reason = interaction.options.getString("reason", true).trim();
    if (!reason) throw new UserError("Enter a reason for the moderation log.");
    const target = interaction.options.getUser("member", true);
    const ban: Ban = {
      id: interaction.id,
      moderator: interaction.user.id,
      target: target.id,
      reason,
      created: Date.now(),
    };
    confirmations.add(ban.id, ban);
    const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Danger)
        .setLabel("Confirm ban")
        .setCustomId(`ban-confirm:${ban.id}`),
      new ButtonBuilder()
        .setStyle(ButtonStyle.Secondary)
        .setLabel("Cancel")
        .setCustomId(`ban-cancel:${ban.id}`),
    );
    await interaction.reply({
      content: `Ban <@${target.id}> (\`${target.id}\`)?\nReason: ${escapeMarkdown(reason)}`,
      components: [buttons],
      flags: MessageFlags.Ephemeral,
      allowedMentions: quiet,
    });
  }

  async function finishBan(
    interaction: ButtonInteraction<"cached">,
    id: string,
    confirm: boolean,
  ) {
    const ban = confirmations.get(id);
    if (!ban || ban.moderator !== interaction.user.id)
      throw new UserError("This ban confirmation has expired.");
    confirmations.remove(id);
    if (!confirm) {
      await interaction.update({ content: "Ban cancelled.", components: [] });
      return;
    }
    await interaction.deferUpdate();
    const guild = interaction.guild;
    const [moderator, target, bot, audit] = await Promise.all([
      member(guild, ban.moderator),
      member(guild, ban.target).catch((error) => {
        if (discordCode(error) === 10007)
          throw new UserError("The target is no longer a guild member.");
        throw error;
      }),
      guild.members.fetchMe({ force: true }),
      staffChannel(guild, config, "audit"),
      guild.roles.fetch(),
    ]);
    requireMod(config, moderator);
    if (!canBan(bot, moderator, target))
      throw new UserError(
        "You or Benchy cannot ban that member. Check the role hierarchy.",
      );
    assertBotPermissions(audit, bot, [
      ViewChannel,
      SendMessages,
      ReadMessageHistory,
      EmbedLinks,
    ]);
    if (await currentBan(guild, target.id))
      throw new UserError("That member is already banned.");
    ban.created = Date.now();
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

  async function setLock(
    interaction: ChatInputCommandInteraction<"cached">,
    locked: boolean,
  ) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const guild = interaction.guild;
    const post = locked ? null : interaction.options.getString("post");
    const channelId =
      post === null ? interaction.channelId : postId(post, guild.id);
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

  return async function handle(interaction: import("discord.js").Interaction) {
    if (!interaction.inCachedGuild() || interaction.guildId !== config.guild)
      return;
    try {
      if (interaction.isChatInputCommand()) {
        switch (interaction.commandName) {
          case "info":
            await interaction.reply({
              embeds: [info()],
              allowedMentions: quiet,
            });
            break;
          case "ban":
            await beginBan(interaction);
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
        interaction.customId.startsWith("support:")
      ) {
        await finishSupport(
          interaction,
          interaction.customId.slice("support:".length),
        );
      } else if (interaction.isButton()) {
        const [action, id] = interaction.customId.split(":");
        if (id && (action === "ban-confirm" || action === "ban-cancel")) {
          await finishBan(interaction, id, action === "ban-confirm");
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
