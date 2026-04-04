# onecli/nanoclaw

This repo is a thin fork of [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw) customized for **OneCLI Cloud** users.

It tracks upstream closely — the goal is to stay **one commit ahead** with only the changes listed below.

## What this fork changes

### 1. OneCLI Cloud instead of local OneCLI

Upstream assumes a self-hosted OneCLI gateway running locally (`http://127.0.0.1:10254`). This fork points everything at **OneCLI Cloud** (`https://app.onecli.sh`):

- **`src/config.ts`** — adds `ONECLI_API_KEY` to env reader and exports it (cloud auth requires an API key, local does not)
- **`src/container-runner.ts`** and **`src/index.ts`** — pass `apiKey` to `new OneCLI()` constructor
- **`setup/SKILL.md`** and **`init-onecli/SKILL.md`** — rewritten to:
  - Skip local gateway install (`curl onecli.sh/install | sh` removed, only CLI installed)
  - Default `ONECLI_URL` to `https://app.onecli.sh`
  - Add `ONECLI_API_KEY` setup flow (dashboard Settings > API Keys)
  - Authenticate CLI via `onecli auth login --api-key`
  - Use cloud dashboard URLs (`${ONECLI_URL}/connections/secrets`)
  - Remove local-only troubleshooting (port conflicts, `onecli start`, gateway polling)

### 2. Org rename in skill files

All upstream remote references changed from `qwibitai/nanoclaw` to `onecli/nanoclaw` across skill files (add-compact, add-emacs, add-ollama-tool, channel-formatting, convert-to-apple-container, update-nanoclaw, update-skills, use-native-credential-proxy).

## Rebase guide

```bash
git fetch upstream
git rebase upstream/main
```

### Typical conflict areas

| File | What upstream changes | What we need to keep |
|---|---|---|
| `src/config.ts` | `ONECLI_URL` definition, env reader | Our `ONECLI_API_KEY` export + no hardcoded localhost default |
| `src/container-runner.ts` | `new OneCLI(...)` constructor | `apiKey: ONECLI_API_KEY` in constructor |
| `src/index.ts` | `new OneCLI(...)` constructor | `apiKey: ONECLI_API_KEY` in constructor |
| `init-onecli/SKILL.md` | OneCLI setup flow, dashboard URLs | Cloud flow: no gateway install, API key auth, cloud URLs |
| `setup/SKILL.md` | Section 4a (credential system), troubleshooting | Cloud flow: no gateway install, API key auth, cloud URLs |
| `*.SKILL.md` (various) | Upstream remote URL | `onecli/nanoclaw` instead of `qwibitai/nanoclaw` |

### Resolution principle

- **Code (`src/`)**: take upstream's structural changes, layer our `ONECLI_API_KEY` additions on top
- **Skill files**: take upstream's new content/instructions, but keep our cloud-oriented language, URLs, and auth flow — never reintroduce local gateway install or `http://127.0.0.1:10254` references
- **Org renames**: always resolve to `onecli/nanoclaw`
