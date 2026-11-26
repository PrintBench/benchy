import { randomBytes } from "node:crypto";
import { PermissionFlagsBits } from "discord.js";
import type { Guild, GuildMember } from "discord.js";
import type { Config } from "./config.js";
import {
  assertBotPermissions,
  discordCode,
  member,
  staffChannel,
  UserError,
} from "./discord.js";
import { errorDetails, log } from "./log.js";
import type { Store } from "./store.js";

const discordApi = "https://discord.com/api/v10";
const {
  ManageRoles,
  ViewChannel,
  SendMessages,
  ReadMessageHistory,
  EmbedLinks,
} = PermissionFlagsBits;

function org(config: Config) {
  return config.repository.split("/")[0];
}

export function contributionUrl(input: string, organization: string) {
  const value = input.trim();
  const url = URL.parse(value);
  const [owner, repo, ...path] = url?.pathname.slice(1).split("/") ?? [];
  if (
    value.length > 450 ||
    url?.origin !== "https://github.com" ||
    url.username ||
    url.password ||
    owner.toLowerCase() !== organization.toLowerCase() ||
    !/^[a-z\d_.-]+$/i.test(repo) ||
    !path.some(Boolean)
  )
    throw new UserError(
      `Enter a link to a specific contribution in the ${organization} GitHub organization.`,
    );
  url.search = "";
  return url;
}

type Award = {
  id: string;
  target: string;
  reason: string;
  evidence: string;
  moderator?: GuildMember;
  github?: string;
};

export async function grantContributor(
  guild: Guild,
  config: Config,
  store: Store,
  award: Award,
) {
  const roleId = config.contributor?.role;
  if (!roleId)
    throw new UserError("The Contributor role has not been configured.");
  const [roles, bot, target, audit] = await Promise.all([
    guild.roles.fetch(),
    guild.members.fetchMe({ force: true }),
    member(guild, award.target).catch((error) => {
      if (discordCode(error) === 10007)
        throw new UserError("The member must be in the Discord server.");
      throw error;
    }),
    staffChannel(guild, config, "audit"),
  ]);
  const role = roles.get(roleId);
  if (
    !role ||
    role.managed ||
    role.permissions.bitfield !== 0n ||
    !bot.permissions.has(ManageRoles) ||
    bot.roles.highest.comparePositionTo(role) <= 0
  ) {
    throw new UserError(
      "Benchy needs Manage Roles and a Contributor role with no guild permissions below its own role.",
    );
  }
  const moderator = award.moderator;
  if (
    moderator &&
    (!moderator.permissions.has(ManageRoles) ||
      (moderator.id !== guild.ownerId &&
        moderator.roles.highest.comparePositionTo(role) <= 0))
  ) {
    throw new UserError("You need Manage Roles and a role above Contributor.");
  }
  if (target.pending || target.user.bot) {
    throw new UserError(
      "The member must have completed server rules screening.",
    );
  }
  assertBotPermissions(audit, bot, [
    ViewChannel,
    SendMessages,
    ReadMessageHistory,
    EmbedLinks,
  ]);
  if (award.github && !store.claimContributor(award.target, award.github)) {
    throw new UserError(
      "One of these accounts is already linked to a different Contributor claim. Ask a moderator for help.",
    );
  }
  if (target.roles.cache.has(roleId)) return false;

  await target.roles.add(
    roleId,
    `Benchy | ${moderator ? `Moderator ${moderator.id}` : "Verified GitHub contribution"} | ${award.reason.toWellFormed()}`,
  );
  store.recordMemberAudit(award.id, {
    action: "contributor",
    moderator: moderator?.id ?? award.target,
    target: award.target,
    reason: award.reason,
    evidence: award.evidence,
    created: Date.now(),
  });
  return true;
}

async function readJson<T>(
  request: typeof fetch,
  url: string | URL,
  init: RequestInit = {},
) {
  const response = await request(url, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok)
    throw Object.assign(new Error("Contributor verification request failed"), {
      status: response.status,
    });
  return (await response.json()) as T;
}

type GitHubAuthor = { id: number; login: string; type: string };
type GitHubResult = {
  incomplete_results: boolean;
  items: {
    user?: GitHubAuthor;
    html_url: string;
    pull_request?: { merged_at?: string | null };
  }[];
};

async function mergedContribution(
  request: typeof fetch,
  account: string,
  organization: string,
) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "PrintBench-Benchy",
  };
  const profile = await readJson<GitHubAuthor>(
    request,
    `https://api.github.com/user/${account}`,
    { headers },
  );
  if (
    String(profile.id) !== account ||
    profile.type !== "User" ||
    !/^[a-z\d][a-z\d-]{0,38}$/i.test(profile.login)
  ) {
    throw new UserError("The linked GitHub account could not be verified.");
  }
  const address = new URL("https://api.github.com/search/issues");
  address.searchParams.set(
    "q",
    `org:${organization} is:pr is:merged author:${profile.login}`,
  );
  address.searchParams.set("per_page", "10");
  const results = await readJson<GitHubResult>(request, address, { headers });
  for (const entry of results.items) {
    if (String(entry.user?.id) !== account || !entry.pull_request?.merged_at)
      continue;
    const url = contributionUrl(entry.html_url, organization);
    if (/^\/[^/]+\/[^/]+\/pull\/\d+$/.test(url.pathname)) return url.href;
  }
  if (results.incomplete_results)
    throw new Error("GitHub returned incomplete search results");
  throw new UserError(
    "No merged public PrintBench pull request was found. Ask a moderator about other contributions.",
  );
}

type Connection = {
  id: string;
  type: string;
  verified: boolean;
  revoked?: boolean;
};

export function contributorClaims(
  config: Config,
  store: Store,
  getGuild: () => Guild | undefined,
  request = fetch,
) {
  const oauth = config.contributor?.oauth;
  if (!oauth) return undefined;
  const pending = new Map<
    string,
    { id: string; member: string; application: string; expires: number }
  >();

  return {
    start(member: string, application: string, id: string) {
      const now = Date.now();
      let state: string | undefined;
      for (const [key, claim] of pending) {
        if (claim.expires <= now) pending.delete(key);
        else if (claim.member === member) state = key;
      }
      if (!state) {
        state = randomBytes(32).toString("hex");
        pending.set(state, {
          id,
          member,
          application,
          expires: now + 5 * 60_000,
        });
      }
      const authorize = new URL("https://discord.com/oauth2/authorize");
      authorize.search = new URLSearchParams({
        client_id: application,
        response_type: "code",
        redirect_uri: oauth.redirect,
        scope: "identify connections",
        state,
      }).toString();
      return authorize.href;
    },

    async complete(url: URL) {
      const state = url.searchParams.get("state") ?? "";
      const claim = pending.get(state);
      pending.delete(state);
      if (!claim || claim.expires <= Date.now()) {
        return {
          status: 400,
          body: "This claim link expired. Run /contributor claim in Discord again.\n",
        };
      }
      const code = url.searchParams.get("code");
      if (url.searchParams.has("error") || !code) {
        return {
          status: 400,
          body: "Discord authorization was cancelled. You can run /contributor claim again.\n",
        };
      }
      const guild = getGuild();
      if (!guild)
        return {
          status: 503,
          body: "Benchy is reconnecting. Try again from Discord shortly.\n",
        };

      try {
        const token = await readJson<{ access_token?: string }>(
          request,
          `${discordApi}/oauth2/token`,
          {
            method: "POST",
            body: new URLSearchParams({
              client_id: claim.application,
              client_secret: oauth.secret,
              grant_type: "authorization_code",
              code,
              redirect_uri: oauth.redirect,
            }),
          },
        );
        if (!token.access_token)
          throw new Error("Discord did not return an access token");
        const headers = { Authorization: `Bearer ${token.access_token}` };
        const profile = await readJson<{ id: string }>(
          request,
          `${discordApi}/users/@me`,
          { headers },
        );
        if (profile.id !== claim.member) {
          return {
            status: 403,
            body: "Sign in with the Discord account that started this claim.\n",
          };
        }
        const connections = await readJson<Connection[]>(
          request,
          `${discordApi}/users/@me/connections`,
          { headers },
        );
        const accounts = new Set(
          connections
            .filter(
              ({ id, type, verified, revoked }) =>
                type === "github" &&
                verified === true &&
                revoked !== true &&
                /^[1-9]\d{0,15}$/.test(id),
            )
            .map(({ id }) => id),
        );
        const [account] = accounts;
        if (accounts.size !== 1)
          throw new UserError(
            "Connect one verified GitHub account in Discord’s Connections settings, then try again.",
          );

        const evidence = await mergedContribution(
          request,
          account,
          org(config),
        );
        const granted = await grantContributor(guild, config, store, {
          id: claim.id,
          target: claim.member,
          github: account,
          reason: "Verified a merged GitHub pull request",
          evidence,
        });
        return {
          status: 200,
          body: granted
            ? "Contributor role granted. You can return to Discord.\n"
            : "You already have the Contributor role.\n",
        };
      } catch (error) {
        if (error instanceof UserError)
          return { status: 422, body: `${error.message}\n` };
        log("error", "contributor_verification_failed", errorDetails(error));
        return {
          status: 503,
          body: "Benchy could not complete verification. Run /contributor claim again shortly.\n",
        };
      }
    },
  };
}
