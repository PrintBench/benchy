import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Routes,
} from "discord.js";
import type { Guild, GuildMember } from "discord.js";
import { commands, commandHandlers } from "./commands.js";
import { loadConfig } from "./config.js";
import { contributorClaims } from "./contributors.js";
import {
  drainJobs,
  quiet,
  reconcileMemberEvents,
  UserError,
  validateGuild,
} from "./discord.js";
import { releasePoller, webServer } from "./github.js";
import { errorDetails, log } from "./log.js";
import { Store } from "./store.js";

const config = loadConfig();
const store = new Store(config.dataDirectory);
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  allowedMentions: quiet,
  rest: { timeout: 15_000, retries: 0 },
});
const poll = releasePoller(config.repository, store);
const active = new Map<string, Promise<void>>();
const intervals: NodeJS.Timeout[] = [];
let shuttingDown = false;
let configuredGuild: Guild | undefined;
const claims = contributorClaims(config, store, () =>
  guildReady() ? configuredGuild : undefined,
);
const handleCommand = commandHandlers(config, store, claims);

function startTask(name: string, action: () => Promise<unknown>) {
  if (active.has(name) || shuttingDown) return;
  const promise = Promise.resolve()
    .then(async () => {
      await action();
    })
    .catch((error) =>
      log("error", name, {
        ...errorDetails(error),
        ...(error instanceof UserError ? { message: error.message } : {}),
      }),
    )
    .finally(() => {
      active.delete(name);
    });
  active.set(name, promise);
}

function guildReady() {
  return (
    !shuttingDown && client.isReady() && configuredGuild?.available === true
  );
}

async function configureDiscord() {
  if (configuredGuild || !client.isReady()) return;
  const guild = await client.guilds.fetch(config.guild);
  await validateGuild(guild, config);
  await client.rest.put(
    Routes.applicationGuildCommands(client.user.id, guild.id),
    { body: commands },
  );
  if (shuttingDown) return;
  configuredGuild = guild;
  log("info", "discord_ready", {
    guild: guild.id,
    application: client.user.id,
  });
  startTask("reconcile_members", () => reconcileMemberEvents(guild, store));
  startTask("drain_deliveries", () => drainJobs(guild, config, store));
}

function trackJoin(member: GuildMember) {
  if (
    shuttingDown ||
    member.guild.id !== config.guild ||
    member.user.bot ||
    !member.joinedTimestamp
  )
    return;
  try {
    if (member.pending)
      store.rememberScreening(member.id, member.joinedTimestamp);
    else store.welcome(member.id, member.joinedTimestamp);
  } catch (error) {
    log("error", "record_join_failed", {
      member: member.id,
      ...errorDetails(error),
    });
  }
}

client.on(Events.GuildMemberAdd, trackJoin);
client.on(Events.GuildMemberUpdate, (previous, current) => {
  if (previous.pending === true && !current.pending) trackJoin(current);
});
client.on(Events.InteractionCreate, (interaction) => {
  if (interaction.guildId !== config.guild || !interaction.isRepliable())
    return;
  startTask(`interaction:${interaction.id}`, () =>
    guildReady()
      ? handleCommand(interaction)
      : interaction.reply({
          content: "Benchy is still connecting. Try again shortly.",
          flags: MessageFlags.Ephemeral,
        }),
  );
});
client.on(Events.Error, (error) =>
  log("error", "discord_client_error", errorDetails(error)),
);
client.on(Events.ShardError, (error) =>
  log("error", "discord_gateway_error", errorDetails(error)),
);
client.once(Events.ClientReady, () =>
  startTask("configure_discord", configureDiscord),
);

const server = webServer(
  config,
  store,
  guildReady,
  () => !shuttingDown,
  claims?.complete,
);
server.on("error", (error) => {
  log("error", "http_server_failed", errorDetails(error));
  void shutdown(1);
});

async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("info", "shutting_down", { exitCode });
  const timeout = setTimeout(() => process.exit(exitCode || 1), 25_000).unref();
  for (const interval of intervals) clearInterval(interval);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await Promise.allSettled(active.values());
  await client.destroy();
  store.close();
  clearTimeout(timeout);
  process.exitCode = exitCode;
}

process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
server.listen(config.port, "0.0.0.0", () =>
  log("info", "http_listening", { port: config.port }),
);
startTask("poll_releases", poll);
intervals.push(
  setInterval(() => startTask("poll_releases", poll), 5 * 60_000),
  setInterval(() => startTask("configure_discord", configureDiscord), 30_000),
  setInterval(() => {
    if (guildReady())
      startTask("reconcile_members", () =>
        reconcileMemberEvents(configuredGuild!, store),
      );
  }, 30_000),
  setInterval(() => {
    if (guildReady())
      startTask("drain_deliveries", () =>
        drainJobs(configuredGuild!, config, store),
      );
  }, 2_000),
);
try {
  await client.login(config.token);
} catch (error) {
  log("error", "discord_login_failed", errorDetails(error));
  await shutdown(1);
}
