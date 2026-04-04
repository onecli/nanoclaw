# Merge All Modules

Rebuild the `image` branch by merging all channels and addons onto `main`.

> **This skill lives on `main` intentionally.** The `image` branch is rebuilt via `git reset --hard main`, so anything only on `image` gets wiped. By living on `main`, this skill (and any deploy files) survive the rebuild.

## Prerequisites

Must be run from the nanoclaw repo root. All channel/addon remotes must already be configured (the skill will add any missing ones).

## Steps

### 1. Start from main

```bash
git checkout main
git pull origin main
```

### 2. Ensure remotes exist

```bash
# Channel remotes
git remote get-url telegram 2>/dev/null || git remote add telegram https://github.com/qwibitai/nanoclaw-telegram.git
git remote get-url whatsapp 2>/dev/null || git remote add whatsapp https://github.com/qwibitai/nanoclaw-whatsapp.git
git remote get-url slack 2>/dev/null || git remote add slack https://github.com/qwibitai/nanoclaw-slack.git
git remote get-url discord 2>/dev/null || git remote add discord https://github.com/qwibitai/nanoclaw-discord.git
git remote get-url gmail 2>/dev/null || git remote add gmail https://github.com/qwibitai/nanoclaw-gmail.git

# upstream (for core addons)
git remote get-url upstream 2>/dev/null || git remote add upstream https://github.com/qwibitai/nanoclaw.git
```

### 3. Fetch all remotes

```bash
git fetch --all
```

### 4. Reset image branch to main

```bash
git checkout image 2>/dev/null || git checkout -b image
git reset --hard main
```

### 5. Merge channels (one at a time)

Merge each channel. If there are conflicts, resolve them and continue.

```bash
git merge --no-edit telegram/main
git merge --no-edit whatsapp/main
git merge --no-edit slack/main
git merge --no-edit discord/main
git merge --no-edit gmail/main
```

### 6. Merge addons

```bash
# WhatsApp addons
git merge --no-edit whatsapp/skill/image-vision
git merge --no-edit whatsapp/skill/pdf-reader
git merge --no-edit whatsapp/skill/reactions
git merge --no-edit whatsapp/skill/voice-transcription

# Core addons
git merge --no-edit upstream/skill/compact
git merge --no-edit upstream/skill/channel-formatting
```

### 7. Restore core files from main

Channel merges may overwrite shared files with older versions. Restore these from `main` to ensure latest features (like `is_main` in db.ts) are preserved:

```bash
git checkout main -- src/db.ts src/index.ts src/config.ts src/channels/registry.ts
```

### 8. Register all channels

Verify `src/channels/index.ts` exports all 5 channels. If any are missing after merges, add them:

```typescript
export { default as discord } from './discord/index.js';
export { default as gmail } from './gmail/index.js';
export { default as slack } from './slack/index.js';
export { default as telegram } from './telegram/index.js';
export { default as whatsapp } from './whatsapp/index.js';
```

### 9. Cloud deploy patches

Apply these changes directly to the merged code before building:

**WhatsApp QR file output** — In `src/channels/whatsapp.ts`, always write QR data to a file (harmless locally, needed for cloud):

1. Add `DATA_DIR` to the config import:
   ```typescript
   import { ASSISTANT_HAS_OWN_NUMBER, ASSISTANT_NAME, DATA_DIR, STORE_DIR } from '../config.js';
   ```

2. Add constant after `GROUP_SYNC_INTERVAL_MS`:
   ```typescript
   const QR_FILE_PATH = path.join(DATA_DIR, 'whatsapp-qr.json');
   ```

3. In the `if (qr) { ... }` block inside `connection.update`, add the file write **before** the existing notification/exit logic:
   ```typescript
   if (qr) {
     // Write QR to file so external APIs (bootstrap, dashboard) can serve it
     fs.mkdirSync(path.dirname(QR_FILE_PATH), { recursive: true });
     fs.writeFileSync(
       QR_FILE_PATH,
       JSON.stringify({ qr, timestamp: Date.now(), status: 'waiting' }),
     );

     const msg = 'WhatsApp authentication required. Run /setup in Claude Code.';
     logger.error(msg);
     exec(
       `osascript -e 'display notification "${msg}" with title "NanoClaw" sound name "Basso"'`,
     );
     setTimeout(() => process.exit(1), 1000);
   }
   ```

4. Add after `logger.info('Connected to WhatsApp');` in the `connection === 'open'` block:
   ```typescript
   fs.writeFileSync(
     QR_FILE_PATH,
     JSON.stringify({ qr: null, timestamp: Date.now(), status: 'authenticated' }),
   );
   ```

**Agent image type fix** — In `container/agent-runner/src/index.ts`, the `ImageContentBlock` interface has `media_type: string` which is too loose for the Claude SDK. Narrow it:

1. Change the `media_type` field in `ImageContentBlock`:
   ```typescript
   source: { type: 'base64'; media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'; data: string };
   ```

2. Where `img.mediaType` is used (in the image attachments block), cast it:
   ```typescript
   blocks.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType as ImageContentBlock['source']['media_type'], data } });
   ```

**Auto-register for cloud deploy** — In ALL channel files (`src/channels/telegram.ts`, `src/channels/whatsapp.ts`, `src/channels/slack.ts`, `src/channels/discord.ts`), find where the channel checks if a chat is registered and returns/skips if not. Each channel has a pattern like `const group = this.opts.registeredGroups()[chatJid]; if (!group) { return; }`.

For each channel:

1. **Add `tryAutoRegister` to the channel's Opts interface** — each channel may define its own interface (e.g. `TelegramChannelOpts`, `WhatsAppChannelOpts`) instead of using the shared `ChannelOpts`. Add `tryAutoRegister?: (chatJid: string, chatName: string, isGroup: boolean) => boolean;` to each one.
2. Change `const group` (or `const groups`) to `let`
3. Before the "not registered" return, try auto-registering: `this.opts.tryAutoRegister?.(chatJid, chatName, isGroup)`
4. If it succeeds, re-read the group from `registeredGroups()` and continue
5. Use the channel's existing `isGroup` variable, or derive it (e.g. WhatsApp: `chatJid.endsWith('@g.us')`, Telegram: `ctx.chat.type === 'group'`, Discord: `!message.channel.isDMBased()`, Slack: `event.channel_type !== 'im'`)

The result should be: if `tryAutoRegister` returns true, the message is processed normally instead of being dropped.

### 10. Install, format, and build

```bash
npm install
npx prettier --write "src/**/*.ts"
npm run build
```

Fix any build errors. Common issues:
- Duplicate imports after merges — deduplicate
- Missing channel registrations — add to `src/channels/index.ts`
- Type conflicts — resolve in favor of the newer type

### 11. Build Docker images

Build both images locally to verify they compile before pushing:

```bash
# VM image (includes NanoClaw + bootstrap API)
docker build -f Dockerfile.vm -t nanoclaw-vm:test .

# Agent image (runs inside containers spawned by NanoClaw)
docker build -f container/Dockerfile -t nanoclaw-agent:test ./container
```

Fix any build failures before proceeding. Common issues:
- Native module errors (sharp, better-sqlite3) — ensure `build-essential` and `python3` are in the Dockerfile
- Type mismatches with SDK — narrow types to match SDK expectations

### 12. Commit and force-push

```bash
git add -A
git commit -m "rebuild: merge all channels and addons"
git push --force origin image
```

## Modules included

| Module | Remote | Branch | Type |
|--------|--------|--------|------|
| Telegram | `telegram` | `main` | Channel |
| WhatsApp | `whatsapp` | `main` | Channel |
| Slack | `slack` | `main` | Channel |
| Discord | `discord` | `main` | Channel |
| Gmail | `gmail` | `main` | Channel |
| Image Vision | `whatsapp` | `skill/image-vision` | WhatsApp addon |
| PDF Reader | `whatsapp` | `skill/pdf-reader` | WhatsApp addon |
| Reactions | `whatsapp` | `skill/reactions` | WhatsApp addon |
| Voice Transcription | `whatsapp` | `skill/voice-transcription` | WhatsApp addon |
| Compact | `upstream` | `skill/compact` | Core addon |
| Channel Formatting | `upstream` | `skill/channel-formatting` | Core addon |

## Cloud deploy patches (applied in step 7)

| Patch | File | Purpose |
|-------|------|---------|
| QR File Output | `src/channels/whatsapp.ts` | Always write QR to `data/whatsapp-qr.json` |
| Image type fix | `container/agent-runner/src/index.ts` | Narrow `media_type` to match Claude SDK types |
| Auto-register | `src/channels/{telegram,whatsapp,slack,discord}.ts` | Call `tryAutoRegister` before dropping unregistered messages |

## NOT included

emacs, ollama, apple-container, native-credential-proxy, local-whisper (not relevant for cloud deploy).
