import { createHash, randomBytes } from "node:crypto";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import type {
  APIEmbed,
  ButtonInteraction,
  ChatInputCommandInteraction,
  Guild,
  ModalSubmitInteraction,
} from "discord.js";
import { Actions } from "./actions.js";
import type { Config } from "./config.js";
import { embedColors, printBenchLogo } from "./embeds.js";
import {
  assertBotPermissions,
  deliveryMarkerLength,
  discordCode,
  findRecentMessage,
  member,
  quiet,
  textChannel,
  UserError,
} from "./discord.js";
import type {
  RulesMessage,
  RulesPublication,
  MarkdownText,
  Store,
} from "./store.js";

const {
  ManageGuild,
  ViewChannel,
  ReadMessageHistory,
  SendMessages,
  EmbedLinks,
} = PermissionFlagsBits;
const inputLimit = 4_000;
const descriptionLimit = 4_096;
const titleLimit = 200;
const messageLimit = 6_000;
const announcementAuthor = {
  name: "PrintBench · Announcement",
  icon_url: printBenchLogo,
};
const editor = {
  rules: {
    command: "/setup rules",
    modalTitle: "Set up server rules",
    title: "PrintBench Rules",
    markdownLabel: "Rules in Markdown",
    cancelMessage: "Rules draft cancelled.",
  },
  announcement: {
    command: "/announce",
    modalTitle: "Create an announcement",
    title: "",
    markdownLabel: "Announcement in Markdown",
    cancelMessage: "Announcement draft cancelled.",
  },
} as const;
type DraftKind = keyof typeof editor;

export const setupCommand = new SlashCommandBuilder()
  .setName("setup")
  .setDescription("Publish managed PrintBench server messages")
  .setDefaultMemberPermissions(ManageGuild)
  .addSubcommand((option) =>
    option
      .setName("rules")
      .setDescription("Preview and publish the rules channel embed"),
  );

export const announceCommand = new SlashCommandBuilder()
  .setName("announce")
  .setDescription("Preview and publish a Markdown announcement")
  .setDefaultMemberPermissions(ManageGuild)
  .addChannelOption((option) =>
    option
      .setName("channel")
      .setDescription("Where to publish (defaults to this channel)")
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
  );

function cutAt(text: string, max: number, min: number) {
  const window = text.slice(0, max);
  for (const pattern of [
    /\n[ \t]*\n/g,
    /\n(?= {0,3}#{1,6} )/g,
    /\n/g,
    /[ \t]+/g,
  ]) {
    const matches = Array.from(window.matchAll(pattern));
    const last = matches.at(-1);
    const end = last && last.index + last[0].length;
    if (end !== undefined && end >= min && end <= max) return end;
  }
  // Leave a surrogate pair together when an unbroken line needs a hard split.
  return /[\uD800-\uDBFF]/.test(text.charAt(max - 1)) &&
    /[\uDC00-\uDFFF]/.test(text.charAt(max))
    ? max - 1
    : max;
}

function openFence(text: string) {
  let opening: string | undefined;
  for (const line of text.split("\n")) {
    const match = /^ {0,3}(`{3,})([^\n]*)$/.exec(line);
    if (!match) continue;
    if (opening) {
      if (
        !match[2].trim() &&
        match[1].length >= opening.match(/^`+/)![0].length
      )
        opening = undefined;
    } else if (
      match[1].length <= 16 &&
      /^[\w.+#-]{0,32}$/.test(match[2].trim())
    ) {
      opening = match[1] + match[2].trim();
    }
  }
  return opening;
}

function descriptions(body: string) {
  const parts: string[] = [];
  let remaining = body;
  while (remaining.length > (parts.length ? descriptionLimit : inputLimit)) {
    const limit = parts.length ? descriptionLimit : inputLimit;
    const minimum = Math.max(limit - 650, remaining.length - descriptionLimit);
    let cut = cutAt(remaining, limit, minimum);
    let opening = openFence(remaining.slice(0, cut));
    let close = opening?.match(/^`+/)?.[0];
    if (close && cut + close.length + 1 > limit) {
      const safeLimit = limit - 17;
      cut = cutAt(remaining, safeLimit, Math.min(minimum, safeLimit));
      opening = openFence(remaining.slice(0, cut));
      close = opening?.match(/^`+/)?.[0];
    }
    const head = remaining.slice(0, cut);
    const tail = remaining.slice(cut);
    parts.push(
      close
        ? `${head}${head.endsWith("\n") ? "" : "\n"}${close}`
        : head.trimEnd(),
    );
    remaining = opening ? `${opening}\n${tail}` : tail.trimStart();
  }
  if (remaining.trim()) parts.push(remaining);
  return parts;
}

export function renderMarkdown(
  text: MarkdownText,
  kind: DraftKind = "rules",
): APIEmbed[][] {
  const title = text.title.trim();
  const body = [text.markdown, text.continuation]
    .filter((part) => part.trim())
    .join("\n\n")
    .replace(/\r\n?/g, "\n")
    .replace(/^\n+|\s+$/g, "");
  if (!title || title.length > titleLimit)
    throw new UserError("Enter an embed title of up to 200 characters.");
  if (!text.markdown.trim())
    throw new UserError(`Enter the ${kind} in the first Markdown field.`);
  if (
    text.markdown.length > inputLimit ||
    text.continuation.length > inputLimit
  )
    throw new UserError("Use up to 4,000 characters in each Markdown field.");

  const groups: APIEmbed[][] = [[]];
  let group = groups[0];
  let size = title.length;
  const budget =
    kind === "announcement"
      ? messageLimit - announcementAuthor.name.length - deliveryMarkerLength
      : messageLimit;
  for (const description of descriptions(body)) {
    if (size + description.length > budget) {
      group = [];
      groups.push(group);
      size = title.length + " (continued)".length;
    }
    group.push({
      ...(group.length === 0
        ? {
            title: groups.length === 1 ? title : `${title} (continued)`,
            ...(kind === "announcement" && { author: announcementAuthor }),
          }
        : {}),
      description,
      color: embedColors.printBench,
    });
    size += description.length;
  }
  return groups;
}

function modal(id: string, kind: DraftKind, text: MarkdownText) {
  const form = new ModalBuilder()
    .setTitle(editor[kind].modalTitle)
    .setCustomId(`${kind}:form:${id}`);
  const fields = [
    {
      id: "title",
      label: "Embed title",
      value: text.title,
      max: titleLimit,
      required: true,
    },
    {
      id: "markdown",
      label: editor[kind].markdownLabel,
      value: text.markdown,
      max: inputLimit,
      required: true,
    },
    {
      id: "continuation",
      label: "More Markdown",
      value: text.continuation,
      max: inputLimit,
      required: false,
    },
  ];
  for (const field of fields) {
    const input = new TextInputBuilder()
      .setCustomId(field.id)
      .setMaxLength(field.max)
      .setRequired(field.required)
      .setStyle(
        field.id === "title" ? TextInputStyle.Short : TextInputStyle.Paragraph,
      );
    if (field.value) input.setValue(field.value);
    form.addLabelComponents((label) =>
      label.setLabel(field.label).setTextInputComponent(input),
    );
  }
  return form;
}

type RulesChannel = Awaited<ReturnType<typeof textChannel>>;
type DigestibleEmbed = { title?: string | null; description?: string | null };

function digest(embeds: readonly DigestibleEmbed[]) {
  return createHash("sha256")
    .update(
      JSON.stringify(
        embeds.map(({ title, description }) => [
          title ?? null,
          description ?? null,
        ]),
      ),
    )
    .digest("hex");
}

async function rulesMessage(
  channel: RulesChannel,
  publication: RulesPublication,
  slot: RulesMessage,
) {
  const bot = channel.client.user.id;
  if (slot.id) {
    const message = await channel.messages
      .fetch({ message: slot.id, force: true, cache: false })
      .catch((error) => {
        if (discordCode(error) === 10008) return null;
        throw error;
      });
    return message?.author.id === bot ? message : null;
  }
  const pending = slot.pending;
  if (!pending) return null;
  return findRecentMessage(
    channel,
    pending.since,
    (message) =>
      message.author.id === bot &&
      message.createdTimestamp >= pending.since - 5_000 &&
      !publication.messages.some(({ id }) => id === message.id) &&
      pending.digests.includes(digest(message.embeds)),
  );
}

async function updateRules(
  channel: RulesChannel,
  store: Store,
  publication: RulesPublication,
  text: MarkdownText,
) {
  const save = () => store.saveRules(channel.id, publication);
  const groups = renderMarkdown(text);
  publication.revision++;
  save();

  for (const [index, embeds] of groups.entries()) {
    const slot = (publication.messages[index] ??= {});
    const existing = await rulesMessage(channel, publication, slot);
    const expected = digest(embeds);
    const payload = { embeds, allowedMentions: quiet };
    if (existing) {
      slot.id = existing.id;
      delete slot.pending;
      save();
      if (
        digest(existing.embeds) !== expected ||
        existing.embeds.some(({ color }) => color !== embedColors.printBench)
      )
        await existing.edit(payload);
      continue;
    }

    // Save the send attempt first so a retry can recover a message even if Discord
    // accepted it before we received a response. The nonce covers immediate retries.
    delete slot.id;
    const pending = (slot.pending ??= {
      nonce: randomBytes(12).toString("hex"),
      since: Date.now(),
      digests: [],
    });
    if (!pending.digests.includes(expected)) pending.digests.push(expected);
    save();
    const posted = await channel.send({
      ...payload,
      nonce: pending.nonce,
      enforceNonce: true,
    });
    slot.id = posted.id;
    delete slot.pending;
    save();
    if (
      digest(posted.embeds) !== expected ||
      posted.embeds.some(({ color }) => color !== embedColors.printBench)
    )
      await posted.edit(payload);
  }

  for (const extra of publication.messages.slice(groups.length)) {
    const existing = await rulesMessage(channel, publication, extra);
    if (existing) {
      await existing.delete().catch((error) => {
        if (discordCode(error) !== 10008) throw error;
      });
    }
  }
  publication.messages.length = groups.length;
  publication.text = text;
  save();
  return publication.messages[0].id!;
}

type Session = {
  owner: string;
  channel: string;
  text: MarkdownText;
  stage: "form" | "preview";
} & ({ kind: "rules"; revision: number } | { kind: "announcement" });

function requireManager(
  permissions: { has(permission: bigint): boolean } | null,
  kind: DraftKind,
) {
  if (!permissions?.has(ManageGuild))
    throw new UserError(
      kind === "rules"
        ? "You need Manage Server to publish the rules."
        : "You need Manage Server to publish an announcement.",
    );
}

export function publishingCommands(config: Config, store: Store) {
  const sessions = new Actions<Session>();
  let publishing = false;

  function take(
    kind: DraftKind,
    id: string,
    owner: string,
    stage: Session["stage"],
  ) {
    const session = sessions.get(id);
    if (
      session?.kind !== kind ||
      session.owner !== owner ||
      session.stage !== stage
    )
      throw new UserError(
        `This ${kind} draft is unavailable. Run ${editor[kind].command} again.`,
      );
    sessions.remove(id);
    return session;
  }

  async function destination(guild: Guild, session: Session) {
    const [channel, manager] = await Promise.all([
      textChannel(guild, session.channel),
      member(guild, session.owner),
    ]);
    requireManager(manager.permissions, session.kind);
    if (!channel.permissionsFor(manager).has(ViewChannel))
      throw new UserError(
        session.kind === "rules"
          ? "You need access to the configured rules channel."
          : "You need access to the announcement channel.",
      );
    assertBotPermissions(channel, guild.members.me!, [
      ViewChannel,
      SendMessages,
      ReadMessageHistory,
      EmbedLinks,
    ]);
    return channel;
  }

  return {
    async open(
      interaction: ChatInputCommandInteraction<"cached">,
      kind: DraftKind,
    ) {
      requireManager(interaction.member.permissions, kind);
      const text: MarkdownText = {
        title: editor[kind].title,
        markdown: "",
        continuation: "",
      };
      const draft = {
        owner: interaction.user.id,
        text,
        stage: "form" as const,
      };
      if (kind === "rules") {
        const published = store.readRules(config.rules);
        draft.text = published.text ?? draft.text;
        sessions.add(interaction.id, {
          ...draft,
          kind,
          channel: config.rules,
          revision: published.revision,
        });
      } else {
        const channel =
          interaction.options.getChannel("channel")?.id ??
          interaction.channelId;
        sessions.add(interaction.id, { ...draft, kind, channel });
      }
      await interaction.showModal(modal(interaction.id, kind, draft.text));
    },

    async preview(
      interaction: ModalSubmitInteraction<"cached">,
      kind: DraftKind,
    ) {
      const id = interaction.customId.slice(`${kind}:form:`.length);
      const session = take(kind, id, interaction.user.id, "form");
      const text = {
        title: interaction.fields.getTextInputValue("title").trim(),
        markdown: interaction.fields.getTextInputValue("markdown"),
        continuation: interaction.fields.fields.has("continuation")
          ? (interaction.fields.getTextInputValue("continuation") ?? "")
          : "",
      };
      const messages = renderMarkdown(text, kind);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const channel = await destination(interaction.guild, session);
      const previous =
        session.kind === "rules" ? store.readRules(channel.id) : undefined;
      if (session.kind === "rules" && previous?.revision !== session.revision)
        throw new UserError(
          "The rules changed while you were editing. Run /setup rules again.",
        );
      sessions.add(interaction.id, { ...session, stage: "preview", text });
      const controls = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`${kind}:publish:${interaction.id}`)
          .setStyle(ButtonStyle.Primary)
          .setLabel("Publish"),
        new ButtonBuilder()
          .setCustomId(`${kind}:edit:${interaction.id}`)
          .setStyle(ButtonStyle.Secondary)
          .setLabel("Edit"),
        new ButtonBuilder()
          .setCustomId(`${kind}:cancel:${interaction.id}`)
          .setStyle(ButtonStyle.Secondary)
          .setLabel("Cancel"),
      );
      for (const [index, embeds] of messages.entries()) {
        const last = index === messages.length - 1;
        const label =
          messages.length === 1
            ? "Preview"
            : `Preview ${index + 1} of ${messages.length}`;
        const cleanup =
          last && previous && previous.messages.length > messages.length
            ? " Publishing also removes Benchy's old continuation message."
            : "";
        const options = {
          content: `${label} for <#${channel.id}>.${cleanup}`,
          embeds,
          allowedMentions: quiet,
          components: last ? [controls] : [],
        };
        if (index === 0) await interaction.editReply(options);
        else
          await interaction.followUp({
            ...options,
            flags: MessageFlags.Ephemeral,
          });
      }
    },

    async button(interaction: ButtonInteraction<"cached">, kind: DraftKind) {
      const [, action, id] = interaction.customId.split(":");
      if (!id || !["publish", "edit", "cancel"].includes(action)) return;
      const session = take(kind, id, interaction.user.id, "preview");
      if (action === "cancel") {
        await interaction.update({
          content: editor[kind].cancelMessage,
          embeds: [],
          components: [],
        });
        return;
      }
      requireManager(interaction.member.permissions, kind);
      if (action === "edit") {
        sessions.add(interaction.id, { ...session, stage: "form" });
        await interaction.showModal(modal(interaction.id, kind, session.text));
        return;
      }
      if (session.kind === "announcement") {
        await interaction.deferUpdate();
        const channel = await destination(interaction.guild, session);
        store.enqueue(`announcement:${id}`, {
          kind: "announcement",
          channel: channel.id,
          messages: renderMarkdown(session.text, kind),
        });
        await interaction.editReply({
          content: `Announcement queued for <#${channel.id}>.`,
          embeds: [],
          components: [],
          allowedMentions: quiet,
        });
        return;
      }
      if (publishing)
        throw new UserError(
          "A rules update is already being published. Run /setup rules again shortly.",
        );

      publishing = true;
      try {
        await interaction.deferUpdate();
        const channel = await destination(interaction.guild, session);
        const published = store.readRules(channel.id);
        if (published.revision !== session.revision)
          throw new UserError(
            "The rules changed after this preview. Run /setup rules again.",
          );
        const messageId = await updateRules(
          channel,
          store,
          published,
          session.text,
        );
        await interaction.editReply({
          content: `Published in <#${channel.id}>. [Open the rules](https://discord.com/channels/${config.guild}/${channel.id}/${messageId}).`,
          embeds: [],
          components: [],
          allowedMentions: quiet,
        });
      } finally {
        publishing = false;
      }
    },
  };
}
