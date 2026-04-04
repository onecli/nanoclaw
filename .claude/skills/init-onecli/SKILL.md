---
name: init-onecli
description: Configure OneCLI Cloud Agent Vault. Migrates existing .env credentials to the cloud vault. Use after /update-nanoclaw brings in OneCLI as a breaking change, or for first-time OneCLI Cloud setup.
---

# Initialize OneCLI Cloud Agent Vault

This skill configures the OneCLI Cloud Agent Vault gateway and migrates any existing `.env` credentials into it. Run this after `/update-nanoclaw` introduces OneCLI as a breaking change, or any time OneCLI Cloud needs to be set up.

**Principle:** When something is broken or missing, fix it. Don't tell the user to go fix it themselves unless it genuinely requires their manual action (e.g. pasting a token).

## Phase 1: Pre-flight

### Check if OneCLI Cloud is already configured

Check `.env` for OneCLI Cloud configuration:

```bash
grep 'ONECLI_URL' .env && grep 'ONECLI_API_KEY' .env
```

If both are present, check if the cloud gateway is reachable:

```bash
source .env && curl -sf "${ONECLI_URL}/health"
```

If reachable, check the OneCLI Cloud dashboard (Secrets page at ONECLI_URL) for an Anthropic secret.

If an Anthropic secret exists, tell the user OneCLI Cloud is already configured and working. Use AskUserQuestion:

1. **Keep current setup** — description: "OneCLI Cloud is configured and has credentials. Nothing to do."
2. **Reconfigure** — description: "Start fresh — re-register credentials in the cloud."

If they choose to keep, skip to Phase 5 (Verify). If they choose to reconfigure, continue.

### Check for native credential proxy

```bash
grep "credential-proxy" src/index.ts 2>/dev/null
```

If `startCredentialProxy` is imported, the native credential proxy skill is active. Tell the user: "You're currently using the native credential proxy (`.env`-based). This skill will switch you to OneCLI Cloud's Agent Vault, which adds per-agent policies and rate limits. Your `.env` credentials will be migrated to the cloud vault."

Use AskUserQuestion:
1. **Continue** — description: "Switch to OneCLI Cloud Agent Vault."
2. **Cancel** — description: "Keep the native credential proxy."

If they cancel, stop.

### Check the codebase expects OneCLI

```bash
grep "@onecli-sh/sdk" package.json
```

If `@onecli-sh/sdk` is NOT in package.json, the codebase hasn't been updated to use OneCLI yet. Tell the user to run `/update-nanoclaw` first to get the OneCLI integration, then retry `/init-onecli`. Stop here.

## Phase 2: Install & Configure OneCLI CLI

### Install the CLI

```bash
curl -fsSL onecli.sh/cli/install | sh
```

Verify: `onecli version`

If the command is not found, the CLI was likely installed to `~/.local/bin/`. Add it to PATH:

```bash
export PATH="$HOME/.local/bin:$PATH"
grep -q '.local/bin' ~/.bashrc 2>/dev/null || echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
grep -q '.local/bin' ~/.zshrc 2>/dev/null || echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
```

Re-verify with `onecli version`.

### Configure the CLI

Point the CLI at OneCLI Cloud (reads ONECLI_URL from `.env`, defaults to `https://app.onecli.sh`):

```bash
source .env 2>/dev/null
onecli config set api-host "${ONECLI_URL:-https://app.onecli.sh}"
```

### Set ONECLI_URL in .env

```bash
grep -q 'ONECLI_URL' .env 2>/dev/null || echo 'ONECLI_URL=https://app.onecli.sh' >> .env
```

### Set ONECLI_API_KEY in .env

If `ONECLI_API_KEY` is not already in `.env`, ask the user for their API key from the OneCLI Cloud dashboard (Settings → API Keys) and add it:

```bash
echo 'ONECLI_API_KEY=<their-key>' >> .env
```

### Authenticate the CLI

```bash
source .env 2>/dev/null
onecli auth login --api-key "$ONECLI_API_KEY"
```

### Verify cloud gateway is reachable

```bash
source .env && curl -sf "${ONECLI_URL}/health"
```

If the gateway is not reachable, verify the `ONECLI_URL` value in `.env` is correct and that the user has an active OneCLI Cloud account.

## Phase 3: Migrate existing credentials

### Scan .env for credentials to migrate

Read the `.env` file and look for these credential variables:

| .env variable | OneCLI secret type | Host pattern |
|---|---|---|
| `ANTHROPIC_API_KEY` | `anthropic` | `api.anthropic.com` |
| `CLAUDE_CODE_OAUTH_TOKEN` | `anthropic` | `api.anthropic.com` |
| `ANTHROPIC_AUTH_TOKEN` | `anthropic` | `api.anthropic.com` |

Read `.env`:

```bash
cat .env
```

Parse the file for any of the credential variables listed above.

### If credentials found in .env

For each credential found, migrate it to OneCLI Cloud:

**Anthropic API key** (`ANTHROPIC_API_KEY=sk-ant-...`):
```bash
onecli secrets create --name Anthropic --type anthropic --value <key> --host-pattern api.anthropic.com
```

**Claude OAuth token** (`CLAUDE_CODE_OAUTH_TOKEN=...` or `ANTHROPIC_AUTH_TOKEN=...`):
```bash
onecli secrets create --name Anthropic --type anthropic --value <token> --host-pattern api.anthropic.com
```

After successful migration, remove the credential lines from `.env`. Use the Edit tool to remove only the credential variable lines (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_AUTH_TOKEN`). Keep all other `.env` entries intact (e.g. `ONECLI_URL`, `ONECLI_API_KEY`, `TELEGRAM_BOT_TOKEN`, channel tokens).

Verify the secret was registered:
```bash
onecli secrets list
```

Tell the user: "Migrated your Anthropic credentials from `.env` to the OneCLI Cloud Agent Vault. The raw keys have been removed from `.env` — they're now managed by OneCLI Cloud and will be injected at request time without entering containers."

### Offer to migrate other container-facing credentials

After handling Anthropic credentials (whether migrated or freshly registered), scan `.env` again for remaining credential variables that containers use for outbound API calls.

**Important:** Only migrate credentials that containers use via outbound HTTPS. Channel tokens (`TELEGRAM_BOT_TOKEN`, `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `DISCORD_BOT_TOKEN`) are used by the NanoClaw host process to connect to messaging platforms — they must stay in `.env`.

Known container-facing credentials:

| .env variable | Secret name | Host pattern |
|---|---|---|
| `OPENAI_API_KEY` | `OpenAI` | `api.openai.com` |
| `PARALLEL_API_KEY` | `Parallel` | `api.parallel.ai` |

If any of these are found with non-empty values, present them to the user:

AskUserQuestion (multiSelect): "These credentials are used by container agents for outbound API calls. Moving them to the vault means agents never see the raw keys, and you can apply rate limits and policies."

- One option per credential found (e.g., "OPENAI_API_KEY" — description: "Used by voice transcription and other OpenAI integrations inside containers")
- **Skip — keep them in .env** — description: "Leave these in .env for now. You can move them later."

For each credential the user selects:

```bash
onecli secrets create --name <SecretName> --type api_key --value <value> --host-pattern <host>
```

If there are credential variables not in the table above that look container-facing (i.e. not a channel token), ask the user: "Is `<VARIABLE_NAME>` used by agents inside containers? If so, what API host does it authenticate against? (e.g., `api.example.com`)" — then migrate accordingly.

After migration, remove the migrated lines from `.env` using the Edit tool. Keep channel tokens and any credentials the user chose not to migrate.

Verify all secrets were registered:
```bash
onecli secrets list
```

### If no credentials found in .env

No migration needed. Proceed to register credentials fresh.

Check if OneCLI Cloud already has an Anthropic secret:
```bash
onecli secrets list
```

If an Anthropic secret already exists, skip to Phase 4.

Otherwise, register credentials using the same flow as `/setup`:

AskUserQuestion: Do you want to use your **Claude subscription** (Pro/Max) or an **Anthropic API key**?

1. **Claude subscription (Pro/Max)** — description: "Uses your existing Claude Pro or Max subscription. You'll run `claude setup-token` in another terminal to get your token."
2. **Anthropic API key** — description: "Pay-per-use API key from console.anthropic.com."

#### Subscription path

Tell the user to run `claude setup-token` in another terminal and copy the token it outputs. Do NOT collect the token in chat.

Once they have the token, AskUserQuestion with two options:

1. **Dashboard** — description: "Open the dashboard at `${ONECLI_URL}/connections/secrets`, click '+ Add Secret', choose type 'anthropic', and paste your token as the value."
2. **CLI** — description: "Best for remote/headless servers. Run: `onecli secrets create --name Anthropic --type anthropic --value YOUR_TOKEN --host-pattern api.anthropic.com`"

#### API key path

Tell the user to get an API key from https://console.anthropic.com/settings/keys if they don't have one.

AskUserQuestion with two options:

1. **Dashboard** — description: "Open the dashboard at `${ONECLI_URL}/connections/secrets`, click '+ Add Secret', choose type 'anthropic', and paste your key as the value."
2. **CLI** — description: "Best for remote/headless servers. Run: `onecli secrets create --name Anthropic --type anthropic --value YOUR_KEY --host-pattern api.anthropic.com`"

#### After either path

Ask them to let you know when done.

**If the user's response happens to contain a token or key** (starts with `sk-ant-` or looks like a token): handle it gracefully — run the `onecli secrets create` command with that value on their behalf.

**After user confirms:** verify with `onecli secrets list` that an Anthropic secret exists. If not, ask again.

## Phase 4: Build and restart

```bash
npm run build
```

If build fails, diagnose and fix. Common issue: `@onecli-sh/sdk` not installed — run `npm install` first.

Restart the service:
- macOS (launchd): `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`
- Linux (systemd): `systemctl --user restart nanoclaw`
- WSL/manual: stop and re-run `bash start-nanoclaw.sh`

## Phase 5: Verify

Check logs for successful OneCLI integration:

```bash
tail -30 logs/nanoclaw.log | grep -i "onecli\|gateway"
```

Expected: `OneCLI gateway config applied` messages when containers start.

If the service is running and a channel is configured, tell the user to send a test message to verify the agent responds.

Tell the user:
- OneCLI Cloud Agent Vault is now managing credentials
- Agents never see raw API keys — credentials are injected at the gateway level
- To manage secrets: `onecli secrets list`, or open the OneCLI Cloud dashboard
- To add rate limits or policies: `onecli rules create --help`

## Troubleshooting

**"OneCLI gateway not reachable" in logs:** The cloud gateway isn't reachable. Check with `source .env && curl -sf "${ONECLI_URL}/health"`. Verify `ONECLI_URL` and `ONECLI_API_KEY` are correctly set in `.env`.

**Container gets no credentials:** Verify `ONECLI_URL` and `ONECLI_API_KEY` are set in `.env` and the gateway has an Anthropic secret (`onecli secrets list`).

**Old .env credentials still present:** This skill should have removed them. Double-check `.env` for `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, or `ANTHROPIC_AUTH_TOKEN` and remove them manually if still present.
