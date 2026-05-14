# Psychological Counselor Discord Bot

Private Discord bot with long-term memory on Cloudflare D1 + Vectorize, and Codex execution through a swappable runner.

## Architecture

- Discord Interactions hit the Cloudflare Worker at `/discord`.
- Worker verifies Discord signatures and allows only `OWNER_DISCORD_USER_ID`.
- Worker is the search agent: it queries D1, Vectorize, and recent memory, then sends a compact memory pack to the runner.
- Runner is the response agent: it wraps `@openai/codex-sdk` / Codex CLI and uses ChatGPT login instead of OpenAI API billing.
- Runner can be Cloudflare Containers or an on-prem Docker service exposed through `cloudflared tunnel`.

## Runner Modes

On-prem over cloudflared is the default `wrangler.jsonc` mode:

```jsonc
"RUNNER_BACKEND": "http",
"RUNNER_HTTP_BASE_URL": "https://codex-runner.example.com"
```

Cloudflare Container is optional and lives in `wrangler.container.jsonc`:

```jsonc
"RUNNER_BACKEND": "container"
```

Both modes expose the same runner API:

- `POST /auth/start`
- `GET /auth/status`
- `POST /chat`

All runner calls require `Authorization: Bearer $RUNNER_SHARED_SECRET`.

Worker endpoints used by the Discord Gateway bot:

- `POST /dm` receives a DM and returns `{ content, delayMs }`.
- `POST /proactive` returns due casual check-ins for the bot to send.

Both endpoints require `Authorization: Bearer $RUNNER_SHARED_SECRET`.

For plain Discord DM chat, the on-prem compose stack also runs `discord-bot`.
It receives DM messages over Discord Gateway and forwards them to the Worker `/dm`
endpoint, which uses the same D1/Vectorize/Codex memory pipeline as slash commands.
The Worker also stores conversation timing state in D1, returns a fuzzy `delayMs`
for human-ish replies, and exposes `/proactive` so the on-prem bot can send
occasional low-pressure check-ins without putting the Discord bot token in
Cloudflare.

## Local Mac Runner

Create `.env` from `.env.example`, then:

```bash
docker compose -f docker-compose.onprem.yml --env-file .env up -d --build
curl -H "Authorization: Bearer $RUNNER_SHARED_SECRET" http://127.0.0.1:8789/auth/status
```

For on-prem Mac use, the compose file mounts `HOST_CODEX_HOME` to `/home/codex/.codex`.
Set it to your real Codex home if you want to reuse the Mac login directly:

```bash
HOST_CODEX_HOME=/Users/mizuame/.codex
```

If you leave it unset, Docker uses local `./.codex-state`, which is ignored by Git.

The on-prem `discord-bot` service also supports:

```bash
WORKER_PROACTIVE_URL=https://psychological-counselor.example.workers.dev/proactive
PROACTIVE_POLL_INTERVAL_MS=300000
```

Users can steer timing naturally in chat. Phrases like "もっと返信返して" move the
cadence toward fast replies, while "ゆっくりでいい" gives the bot more space.

Expose it with a named tunnel:

```bash
brew install cloudflared
cloudflared tunnel create psychological-counselor-runner
cloudflared tunnel route dns psychological-counselor-runner codex-runner.example.com
cloudflared tunnel --config cloudflared.example.yml run
```

For a persistent tunnel:

```bash
cloudflared service install
```

## Keep The Mac Awake

Temporary launchd keep-awake job:

```bash
launchctl submit -l psychological-counselor-keepawake -- /usr/bin/caffeinate -d -i -s
```

Stop it:

```bash
launchctl remove psychological-counselor-keepawake
```

For lid-closed operation without an external display, macOS may still force sleep. If you explicitly want to disable lid sleep:

```bash
sudo pmset -a disablesleep 1
```

Undo:

```bash
sudo pmset -a disablesleep 0
```

Do not run a closed Mac in a bag or any enclosed space.

## Cloudflare Resources

This repository is public-safe by default. The tracked `wrangler.jsonc` files are templates.
Real Cloudflare resource IDs are generated into ignored local config files:

- `wrangler.local.jsonc`
- `wrangler.container.local.jsonc`

Fully automated first deploy:

```bash
npm run bootstrap
```

That command creates D1 and Vectorize if missing, generates `RUNNER_SHARED_SECRET` into `.env`, pushes the secret to Workers, applies D1 migrations, updates ignored local Wrangler config, and deploys the Worker.

For Cloudflare Containers instead of the on-prem HTTP runner:

```bash
npm run bootstrap:container
```

Manual setup, if you want to do it by hand:

Create D1:

```bash
npx wrangler d1 create psychological-counselor
```

Put the returned `database_id` into `wrangler.jsonc`, then:

```bash
npm run db:migrate:remote
```

Create Vectorize for the default multilingual embedding model:

```bash
npx wrangler vectorize create psychological-counselor-memory --dimensions=1024 --metric=cosine
```

Create secrets:

```bash
npx wrangler secret put RUNNER_SHARED_SECRET
npx wrangler secret put AWS_ACCESS_KEY_ID
npx wrangler secret put AWS_SECRET_ACCESS_KEY
```

Set Discord vars in `wrangler.jsonc` or your deployment environment:

- `DISCORD_APPLICATION_ID`
- `DISCORD_PUBLIC_KEY`
- `OWNER_DISCORD_USER_ID`
- `OWNER_DISCORD_USERNAME` as a fallback when you have not copied the numeric Discord user ID yet

Deploy:

```bash
npm run deploy
```

Deploy with Cloudflare Containers instead:

```bash
npm run deploy:container
```

Register commands for DM / user-install mode:

```bash
npm run commands:register
```

Leave `DISCORD_GUILD_ID` empty to register global commands with `USER_INSTALL` and DM contexts.

Use the Worker URL plus `/discord` as the Discord Interactions Endpoint URL.

Discord Developer Portal settings for DM-only use:

- Installation: enable User Install.
- Default Install Settings for User Install: include `applications.commands`.
- Bot: create a bot user and keep Public Bot off for private use.
- Install Link: use Discord Provided Link or an OAuth2 link for user install.

## Notes

- This bot is designed for private use. The code is publishable, but never commit `.env`, `.dev.vars`, `~/.codex`, R2 credentials, or tunnel credentials.
- `~/.codex` is restored from R2 into the runner's local disk and synced back after login/chat. This is more reliable than using object storage as a live POSIX filesystem.
- The counselor prompt is supportive but does not claim to be a human or clinician. It prioritizes emergency guidance for immediate danger.
