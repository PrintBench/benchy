export const project = {
  website: "https://printbench.app/",
  docs: "https://docs.printbench.app/",
  github: "https://github.com/PrintBench/printbench",
  releases: "https://github.com/PrintBench/printbench/releases/latest",
  download:
    "https://github.com/PrintBench/printbench/releases/latest/download/compose.yaml",
};

export type ContributorConfig = {
  role: string;
  oauth?: { secret: string; redirect: string };
};
export const contributorCallback = "/oauth/discord/callback";

export function loadConfig(env = process.env) {
  function required(name: string) {
    const value = env[name]?.trim();
    if (!value) throw new Error(`Missing ${name}`);
    return value;
  }

  function ids(name: string) {
    const values = required(name)
      .split(",")
      .map((value) => value.trim());
    if (values.some((value) => !/^\d{17,20}$/.test(value))) {
      throw new Error(`Invalid Discord ID in ${name}`);
    }
    return [...new Set(values)];
  }

  function id(name: string) {
    const [value, ...other] = ids(name);
    if (other.length) throw new Error(`Expected one Discord ID in ${name}`);
    return value;
  }

  const repository = env.GITHUB_REPOSITORY?.trim() || "PrintBench/printbench";
  if (!/^[a-z\d-]+\/[a-z\d_.-]+$/i.test(repository)) {
    throw new Error("Invalid GITHUB_REPOSITORY");
  }
  const webhookSecret = required("GITHUB_WEBHOOK_SECRET");
  if (webhookSecret.length < 32)
    throw new Error("GITHUB_WEBHOOK_SECRET must be at least 32 characters");
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid PORT");

  const contributorRole = env.DISCORD_CONTRIBUTOR_ROLE_ID?.trim();
  const oauthSecret = env.DISCORD_OAUTH_CLIENT_SECRET?.trim();
  const publicUrl = env.BENCHY_PUBLIC_URL?.trim();
  if (contributorRole && !/^\d{17,20}$/.test(contributorRole))
    throw new Error("Invalid DISCORD_CONTRIBUTOR_ROLE_ID");
  let contributor: ContributorConfig | undefined;
  if (contributorRole) contributor = { role: contributorRole };
  if (oauthSecret) {
    if (!contributor || !publicUrl)
      throw new Error(
        "Discord OAuth needs DISCORD_CONTRIBUTOR_ROLE_ID and BENCHY_PUBLIC_URL",
      );
    const address = URL.parse(publicUrl);
    if (
      !address ||
      address.protocol !== "https:" ||
      address.username ||
      address.password ||
      address.pathname !== "/" ||
      address.search ||
      address.hash
    )
      throw new Error(
        "BENCHY_PUBLIC_URL must be an HTTPS origin such as https://benchy.example.com",
      );
    contributor.oauth = {
      secret: oauthSecret,
      redirect: `${address.origin}${contributorCallback}`,
    };
  }

  const config = {
    token: required("DISCORD_TOKEN"),
    guild: id("DISCORD_GUILD_ID"),
    releases: id("DISCORD_RELEASES_CHANNEL_ID"),
    releaseRole: id("DISCORD_RELEASE_PINGS_ROLE_ID"),
    github: {
      pull: {
        channel: id("DISCORD_GITHUB_PULL_CHANNEL_ID"),
        role: id("DISCORD_GITHUB_PULL_ROLE_ID"),
      },
      issue: {
        channel: id("DISCORD_GITHUB_ISSUE_CHANNEL_ID"),
        role: id("DISCORD_GITHUB_ISSUE_ROLE_ID"),
      },
    },
    support: id("DISCORD_SUPPORT_FORUM_ID"),
    sources: ids("DISCORD_SUPPORT_SOURCE_IDS"),
    audit: id("DISCORD_MOD_LOG_CHANNEL_ID"),
    moderators: ids("DISCORD_MODERATOR_ROLE_IDS"),
    welcome: id("DISCORD_WELCOME_CHANNEL_ID"),
    rules: id("DISCORD_RULES_CHANNEL_ID"),
    repository,
    webhookSecret,
    port,
    dataDirectory: env.DATA_DIR || "./data",
  };
  const outputs = [
    config.releases,
    config.github.pull.channel,
    config.github.issue.channel,
    config.support,
    config.audit,
    config.welcome,
  ];
  const roles = [
    config.releaseRole,
    config.github.pull.role,
    config.github.issue.role,
    ...config.moderators,
  ];
  if (
    new Set(outputs).size !== outputs.length ||
    config.sources.some((source) => outputs.includes(source)) ||
    new Set(roles).size !== roles.length ||
    roles.includes(config.guild)
  ) {
    throw new Error("Benchy channels and groups must use distinct IDs");
  }
  if (contributor && [config.guild, ...roles].includes(contributor.role))
    throw new Error(
      "The Contributor role must be distinct from the server's other configured roles",
    );
  return { ...config, ...(contributor ? { contributor } : {}) };
}

export type Config = ReturnType<typeof loadConfig>;
