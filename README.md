# Benchy

Benchy is the PrintBench Discord bot. It announces releases, posts newly opened GitHub issues and pull requests, welcomes new members, and gives moderators tools to route support questions, ban members, and close forum posts.

| Command                    | What it does                                                                                                         |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `/info`                    | Shares official PrintBench links with the channel.                                                                   |
| **Apps → Send to Support** | Creates an attributed forum post from a selected message and replies with the new link.                              |
| `/ban member reason`       | Privately confirms a ban and queues an audit entry after Discord accepts it.                                         |
| `/lock`                    | Locks and archives the current forum post.                                                                           |
| `/unlock [post]`           | Reopens a forum post. Run it in another channel with the post URL or ID if the archived post cannot accept commands. |

## Discord setup

1. Create a Discord application and bot named **Benchy** for the server. In the Developer Portal, enable **Server Members Intent**. Install as a server app with the `bot` and `applications.commands` scopes. Restrict installation to administrators you trust.
2. Give Benchy **Ban Members** and put its role above members it needs to ban, below protected staff roles. Do not grant Administrator. Configure the staff roles in `DISCORD_MODERATOR_ROLE_IDS`. A moderator also needs **Ban Members**, **Manage Threads**, or **Manage Messages** in the relevant context.
3. Configure channels and channel overrides using the table below. Reuse existing channels where suitable. Use Developer Mode to copy IDs into the environment. Variables ending in `_IDS` take comma-separated IDs.

| Channel                 | Channel settings                                                                                                                                                                                                                                                                                                |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `#releases`             | Give Benchy View Channel, Send Messages, Embed Links, and Read Message History. Keep `Release Pings` unmentionable by members and grant Benchy **Mention @everyone, @here, and All Roles** only in this channel. Benchy only allows the configured release-role mention here.                                   |
| `#github-activity`      | Deny View Channel to `@everyone`. Allow it for the GitHub Activity role, Benchy's bot role, and any configured staff roles that should see the feed. Add the GitHub Activity role as an optional Community Onboarding choice. Give Benchy Send Messages, Embed Links, and Read Message History.                 |
| `#support`              | Use a forum. Give Benchy View Channel, Send Messages, Read Message History, and Manage Threads. Give intended members View Channel and Send Messages in Threads. If a tag is required, Benchy uses the first non-moderated tag in the forum tag order.                                                          |
| Support source channels | Give Benchy View Channel, Send Messages, Embed Links, and Read Message History. Use text channels with universal view and message history, or channels with the same view overwrites as Support and universal message history. Benchy checks these permissions and the original author's access before copying. |
| `#mod-log`              | Deny View Channel to `@everyone`, and allow it for only Benchy's bot role and configured staff roles. Give Benchy Send Messages, Embed Links, and Read Message History. Server administrators retain Discord's inherent access.                                                                                 |
| `#welcome`              | Make it visible to new members after screening. Give Benchy View Channel, Send Messages, Embed Links, and Read Message History. Set the rules channel ID for the greeting link.                                                                                                                                 |
| Other forums            | Grant Benchy View Channel and Manage Threads wherever staff should be able to use `/lock` and `/unlock`.                                                                                                                                                                                                        |

Turn off Discord's built-in system-channel join messages if they duplicate the new greeting. Leave your existing Community Onboarding questions and release role options in place.

[Discord application setup](https://docs.discord.com/developers/quick-start/getting-started) · [Discord Community Onboarding](https://support.discord.com/hc/en-us/articles/11074987197975-Community-Onboarding-FAQ)

## Deploy on Coolify

1. Start with a test Discord server, its own Discord application and token, and a test public GitHub repository. Use a separate Coolify application, URL, and data volume. Set `GITHUB_REPOSITORY` to the test repository's full name. The production default is `PrintBench/printbench`.
2. Create an application from the `PrintBench/benchy` repository using the **Dockerfile** build pack. Use the repository root, port **3000**, and a domain served over HTTPS. Keep one instance and one data volume. Select **Consistent name (no rolling updates)** in Coolify so two containers never use the queue or Discord token together.
3. Create a persistent volume mounted at **`/data`**. Make it writable by UID/GID 1000 if using a bind mount. Set the variables from [`.env.example`](.env.example) in Coolify and keep the bot token and webhook secret as runtime secrets. Generate the webhook secret with `openssl rand -hex 32`.
4. Deploy and check `GET /ready` and the runtime logs. The Docker health check uses `GET /health` so GitHub deliveries can still queue during Discord reconnects. `/ready` reports whether Benchy has validated its channels and registered its Discord commands.
5. In the source GitHub repository's **Settings → Webhooks**, add `https://YOUR-HOST/webhooks/github`. Use `application/json`, the matching secret, and SSL verification. Subscribe to **Issues** and **Pull requests**. A successful opened event returns `202` once durably queued. Release polling starts automatically and establishes a silent baseline on the first successful check.
6. Run the [staging checks](#staging-checks). Repeat the deployment with production IDs and a fresh volume once the checks pass. Confirm role/channel permissions before activating the production webhook.

[Coolify Dockerfile deployment](https://coolify.io/docs/applications/builds/dockerfile) · [Coolify replacement settings](https://coolify.io/docs/applications/deployments/rolling-updates#settings-that-prevent-a-rolling-update) · [GitHub webhook setup](https://docs.github.com/en/webhooks/using-webhooks/creating-webhooks)

## Staging checks

- Wait for the initial release baseline, publish a prerelease, then promote it to stable. Check descriptions, links, and that only the stable message mentions the test role. Restart the container with the same volume and confirm the announcements stay single.
- Open an issue and pull request. Confirm the embeds are visible to an opted-in regular member and hidden from one without the role. Redeliver a successful webhook and verify it does not post twice. Confirm an incorrect signature gets `401`.
- Route a message with an attachment from an allowed channel. Check the excerpt, author, both links, and repeat routing. Try it from a restricted source or with a member who cannot reply in Support. Lock the new post, confirm regular members cannot reopen it, then use `/unlock post:<link>`.
- Cancel a ban, then confirm a ban on a disposable test member. Try a target above the moderator or Benchy in the hierarchy. Confirm the private audit entry and Discord audit reason, and check that message history survives. A delivery queued before a Discord interruption should appear once service is restored.
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

A **Solved** tag and `/resolve` command would make answered Support questions easy to find. Support forum guidelines can ask for the PrintBench version, deployment method, steps tried, and redacted logs. Discord's native AutoMod can catch mention spam and alert a private staff channel. [PrintBench support guidance](https://github.com/PrintBench/printbench/blob/main/SUPPORT.md) · [Discord AutoMod](https://support.discord.com/hc/en-us/articles/4421269296535-AutoMod-FAQ)
