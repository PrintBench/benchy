# Benchy

Benchy is the PrintBench Discord bot. It announces releases, posts newly opened GitHub issues and pull requests, welcomes new members, and gives moderators tools to run the Support forum, moderate members, and recognize contributors.

| Command                                       | What it does                                                                                                         |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `/setup rules`                                | Opens a private Markdown preview and publishes to the configured rules channel.                                      |
| `/info`                                       | Shares official PrintBench links with the channel.                                                                   |
| **Apps → Send to Support**                    | Creates an attributed forum post from a selected message and replies with the new link.                              |
| `/ban member reason`                          | Privately confirms a ban and queues an audit entry after Discord accepts it.                                         |
| `/kick member reason`                         | Privately confirms a kick and queues an audit entry.                                                                 |
| `/timeout member minutes reason`              | Privately confirms a timeout of 1 minute to 28 days and queues an audit entry.                                       |
| `/untimeout member reason`                    | Privately confirms removal of a timeout and queues an audit entry.                                                   |
| `/resolve [solved]`                           | Marks an active Support post as Solved. Use `solved:false` to clear the tag.                                         |
| `/contributor claim`                          | Checks a verified GitHub connection for a merged PR in the PrintBench organization.                                  |
| `/contributor grant member evidence [reason]` | Lets a moderator recognize a contribution after reviewing the evidence.                                              |
| `/lock`                                       | Locks and archives the current forum post.                                                                           |
| `/unlock [post]`                              | Reopens a forum post. Run it in another channel with the post URL or ID if the archived post cannot accept commands. |

## Discord setup

1. Create a Discord application and bot named **Benchy** for the server. In the Developer Portal, enable **Server Members Intent**. Install as a server app with the `bot` and `applications.commands` scopes. Restrict installation to administrators you trust.
2. Give Benchy **Ban Members**, **Kick Members**, and **Timeout Members**, which the Discord API calls **Moderate Members**. Put its role above members it needs to moderate and below protected staff roles. Configure staff roles in `DISCORD_MODERATOR_ROLE_IDS`. Moderators need the corresponding Discord permission for each command, including **Manage Threads** for forum tags and **Manage Messages** for Support redirects.
3. Configure channels and channel overrides using the table below. Reuse existing channels where suitable. Use Developer Mode to copy IDs into the environment. Variables ending in `_IDS` take comma-separated IDs.

| Channel                 | Channel settings                                                                                                                                                                                                                                                                                                |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `#releases`             | Give Benchy View Channel, Send Messages, Embed Links, and Read Message History. Stable releases ping `Release Pings`.                                                                                                                                                                                           |
| `#pull-requests`        | Set `DISCORD_GITHUB_PULL_CHANNEL_ID` and `DISCORD_GITHUB_PULL_ROLE_ID` to the pull request channel and its opt-in role.                                                                                                                                                                                         |
| `#issues`               | Set `DISCORD_GITHUB_ISSUE_CHANNEL_ID` and `DISCORD_GITHUB_ISSUE_ROLE_ID` to the issue channel and its opt-in role.                                                                                                                                                                                              |
| `#support`              | Use a forum and create one moderator-only tag named **Solved**. Give Benchy View Channel, Send Messages, Read Message History, and Manage Threads. Give intended members View Channel and Send Messages in Threads. If a tag is required, Benchy uses the first available non-moderated tag other than Solved.  |
| Support source channels | Give Benchy View Channel, Send Messages, Embed Links, and Read Message History. Use text channels with universal view and message history, or channels with the same view overwrites as Support and universal message history. Benchy checks these permissions and the original author's access before copying. |
| `#mod-log`              | Deny View Channel to `@everyone`, and allow it for only Benchy's bot role and configured staff roles. Give Benchy Send Messages, Embed Links, and Read Message History. Server administrators retain Discord's inherent access.                                                                                 |
| `#rules`                | Set `DISCORD_RULES_CHANNEL_ID`. Give Benchy View Channel, Send Messages, Embed Links, and Read Message History so it can publish and update its rules posts.                                                                                                                                                    |
| `#welcome`              | Make it visible to new members after screening. Give Benchy View Channel, Send Messages, Embed Links, and Read Message History. Set the rules channel ID for the greeting link.                                                                                                                                 |
| Other forums            | Grant Benchy View Channel and Manage Threads wherever staff should be able to use `/lock` and `/unlock`.                                                                                                                                                                                                        |

Welcome can also be a Support source when it meets the same channel visibility and message history checks.

For each GitHub feed, deny View Channel to `@everyone`. Allow it for its matching opt-in role, Benchy's bot role, and configured staff roles that should see the feed. Give Benchy Send Messages, Embed Links, and Read Message History. Offer each role as a separate Community Onboarding choice.

Keep the ping roles unmentionable by members. In the release, pull request, and issue channels, grant **Mention @everyone, @here, and All Roles** through a channel permission override for the Benchy bot role. Benchy allows only the matching role mention in each feed. A GitHub feed missing mention permission still posts quietly and logs `github_ping_unavailable`.

Turn off Discord's built-in system-channel join messages if they duplicate the new greeting. Leave your existing Community Onboarding questions and release role options in place.

[Discord application setup](https://docs.discord.com/developers/quick-start/getting-started) · [Discord Community Onboarding](https://support.discord.com/hc/en-us/articles/11074987197975-Community-Onboarding-FAQ)

## Publish the rules

Run `/setup rules` with **Manage Server** and access to the rules channel. Enter an embed title and paste Markdown into the first field. Use the optional second field for longer rules. Each field accepts up to 4,000 characters. Benchy splits longer text into embeds, using section or paragraph breaks where possible. It previews separate Discord messages when the combined embed text exceeds the 6,000-character limit for a single message.

Use **Edit**, **Publish**, or **Cancel** from the private preview. The first publish creates a Benchy-managed rules post that you can pin. Later publishes update it in place with pings suppressed, so links to the primary message stay valid. When a shorter version fits in one message, the preview indicates that publishing removes Benchy's previous continuation.

[Discord embed limits](https://docs.discord.com/developers/resources/message#embed-limits)

## Contributor recognition

Create a cosmetic **Contributor** role with all guild permissions off and keep it below Benchy's role. Give Benchy **Manage Roles** and set `DISCORD_CONTRIBUTOR_ROLE_ID`. Moderators with **Manage Roles** above Contributor can grant it after reviewing a link to work in any repository in the organization. This covers issues, reviews, co-authored or direct commits, and other contributions where a moderator can verify the credit. Grants are recorded in `#mod-log`.

To enable self-service, use the HTTPS origin serving Benchy. Compose uses the URL generated by Coolify by default. Set `BENCHY_PUBLIC_URL` to supply a custom HTTPS origin. Under **OAuth2** in the same Discord application, register that origin followed by `/oauth/discord/callback` as a redirect URL. Set its client secret as `DISCORD_OAUTH_CLIENT_SECRET` in Coolify. Exclude OAuth callback query strings from proxy access logs.

A member connects GitHub in Discord's **Connections** settings and runs `/contributor claim`. Benchy checks the verified account for a merged public pull request in any repository under the owner of `GITHUB_REPOSITORY`, which defaults to the PrintBench organization. This covers code, docs, and other merged changes. Benchy saves the two account IDs to keep each verified association unique. Benchy uses the OAuth access token in memory for that verification request.

[Discord OAuth2](https://docs.discord.com/developers/topics/oauth2) · [GitHub pull request search](https://docs.github.com/en/search-github/searching-on-github/searching-issues-and-pull-requests)

## Deploy on Coolify

1. Start with a test Discord server, its own Discord application and token, and a test public GitHub repository. Create a separate Coolify application for each environment. Set `GITHUB_REPOSITORY` to the test repository's full name. The production default is `PrintBench/printbench`.
2. Create an application from `PrintBench/benchy` using the **Docker Compose** build pack. Set the base directory to `/` and the Compose location to `/compose.yaml`. The [Compose file](compose.yaml) builds the Dockerfile, runs one Benchy instance on internal port **3000**, and creates a writable named volume at `/data`. Coolify recreates the Compose container in place on redeploy.
3. With a wildcard domain configured, Coolify generates a URL that routes to Benchy. For a custom HTTPS URL, attach `https://benchy.example.com:3000` to the `benchy` service under **Domains**. The public URL omits `:3000`. Enter the required Discord IDs and runtime secrets under **Environment Variables**, using [`.env.example`](.env.example) as a reference. Generate the webhook secret with `openssl rand -hex 32`.
4. Deploy and check `GET /ready` and the runtime logs. The Docker health check uses `GET /health` so GitHub deliveries can still queue during Discord reconnects. `/ready` reports whether Benchy has validated its channels and registered its Discord commands.
5. In the source GitHub repository's **Settings → Webhooks**, add `https://YOUR-HOST/webhooks/github`. Use `application/json`, the matching secret, and SSL verification. Subscribe to **Issues** and **Pull requests**. A successful opened event returns `202` once durably queued. Release polling starts automatically and establishes a silent baseline on the first successful check.
6. Run the [staging checks](#staging-checks). Repeat the deployment with production IDs and a fresh volume once the checks pass. Confirm role/channel permissions before activating the production webhook.

For an existing deployment with a shared GitHub feed, set all four feed variables and update both channel permission overwrites before redeploying. Keep the same SQLite volume so queued notifications and their delivery history are retained.

For an existing Dockerfile deployment, stop the old app and back up its SQLite volume before switching build packs. Restore the backup to the Compose volume before starting Benchy so it can reuse the notification history and rules message IDs.

[Coolify Docker Compose deployment](https://coolify.io/docs/applications/builds/docker-compose) · [GitHub webhook setup](https://docs.github.com/en/webhooks/using-webhooks/creating-webhooks)

## Staging checks

- Wait for the initial release baseline, publish a prerelease, then promote it to stable. Check descriptions, links, and that only the stable message mentions the test role. Restart the container with the same volume and confirm the announcements stay single.
- Open an issue and pull request. Confirm each embed appears in its assigned channel and pings only the matching role. Verify that a regular member with one opt-in role can see their chosen feed. Redeliver a successful webhook and check for duplicate messages and pings. Confirm an incorrect signature gets `401`.
- Route a message with an attachment from an allowed channel. Check the excerpt, author, both links, and repeat routing. Try it from a restricted source or with a member who cannot reply in Support. Lock the new post, confirm regular members cannot reopen it, then use `/unlock post:<link>`.
- Cancel a ban, then confirm a ban on a disposable test member. Try a target above the moderator or Benchy in the hierarchy. Confirm the private audit entry and Discord audit reason, and check that message history survives. A delivery queued before a Discord interruption should appear once service is restored.
- Preview a long rules post, cancel it, then publish it. Edit it down to one message and check that the primary message link stays the same and the continuation is removed.
- Mark a Support post solved and then clear the tag. Check that its other tags remain. Confirm a timeout, remove it, then kick a disposable test member. Check all three entries in the private moderation log.
- Test a Contributor claim with a linked GitHub account that authored a merged PR in a test organization and with an account that has no merged PR there. Grant Contributor manually using an issue or review link and confirm the audit entry.
- Join as a test member with screening enabled and verify the welcome arrives after acceptance. Repeat with screening off. Check that a rejoin gets a new welcome and open all `/info` links.

## Operate Benchy

- In GitHub **Settings → Webhooks → Recent Deliveries**, redeliver events that failed during a Benchy outage. GitHub does not automatically resend failed attempts. If GitHub got a `202`, inspect Benchy's queue instead.
- In the Coolify container terminal, run `npm run maintenance -- status` to see delivery counts, failed deliveries, and unresolved moderation operations. After fixing a permission or configuration issue, use `npm run maintenance -- retry-job JOB_ID`. Successful sends are reconciled by a delivery marker when the send response was interrupted.
- An uncertain Support post creation is checked against Benchy's forum posts when a moderator repeats the action. If it stays unresolved, first verify in Discord that the original has no matching post, then run `npm run maintenance -- reset-route SOURCE_MESSAGE_ID` and repeat **Send to Support**.
- Back up the data volume using a SQLite-aware backup, or stop the application while making a copy. Keep the same volume when rolling back the image. If moving to a fresh volume, the release snapshot establishes a fresh baseline and the previous delivery and welcome history is lost.
- The SQLite volume contains delivery state and pending moderation reasons. Restrict access to the deployment and backups. Keep the webhook secret and Discord token out of the repository.

[GitHub failed delivery recovery](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries)

## Development

Use Node.js 24.17 or newer within the Node.js 24 series.

```sh
npm ci
npm run check
npm run build
node --env-file=.env dist/src/index.js
```

Copy `.env.example` to `.env` for local development and use test-server IDs and a test token.

## Follow-ups

Support forum guidelines can ask for the PrintBench version, deployment method, steps tried, and redacted logs. Discord's native AutoMod can catch mention spam and alert a private staff channel. [PrintBench support guidance](https://github.com/PrintBench/printbench/blob/main/SUPPORT.md) · [Discord AutoMod](https://support.discord.com/hc/en-us/articles/4421269296535-AutoMod-FAQ)
