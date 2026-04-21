import { exec as execCb, spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

import express, { type Request, type Response } from 'express';

const exec = promisify(execCb);

const PORT = parseInt(process.env.PORT || '8000', 10);
const NANOCLAW_DIR = '/opt/nanoclaw';
const ENV_PATH = `${NANOCLAW_DIR}/.env`;
const STORE_DIR = `${NANOCLAW_DIR}/store`;
const QR_DATA_PATH = `${STORE_DIR}/qr-data.txt`;
const AUTH_STATUS_PATH = `${STORE_DIR}/auth-status.txt`;
const CHANNEL_STATUS_PATH = `${STORE_DIR}/channel-status.json`;
const AUTH_CREDS_PATH = `${STORE_DIR}/auth/creds.json`;
const FIRST_BOOT_SCRIPT = '/opt/first-boot.sh';

const app = express();
app.use(express.json());

let startedAt: number | null = null;
let whatsappAuthProcess: ChildProcess | null = null;

// ── POST /setup ─────────────────────────────────────────────────────────
// Initial VM configuration. Writes OneCLI credentials, pulls agent image,
// starts Docker. Does NOT start NanoClaw — channels must be added first.
app.post('/setup', async (req: Request, res: Response) => {
  const { onecliUrl, onecliApiKey, agentName } = req.body;

  if (!onecliUrl || !onecliApiKey) {
    res.status(400).json({ error: 'onecliUrl and onecliApiKey are required' });
    return;
  }

  try {
    // Write .env with OneCLI credentials only (no channel tokens yet)
    const lines = [
      `ONECLI_URL=${onecliUrl}`,
      `ONECLI_API_KEY=${onecliApiKey}`,
      `ASSISTANT_NAME=${agentName || 'Andy'}`,
      `CONTAINER_IMAGE=ghcr.io/onecli/nanoclaw-agent:latest`,
      `AUTO_REGISTER=true`,
    ];
    fs.writeFileSync(ENV_PATH, lines.join('\n') + '\n');

    // Replace default "Andy" with actual agent name in CLAUDE.md templates
    const name = agentName || 'Andy';
    if (name !== 'Andy') {
      const claudeFiles = [
        path.join(NANOCLAW_DIR, 'groups/main/CLAUDE.md'),
        path.join(NANOCLAW_DIR, 'groups/global/CLAUDE.md'),
      ];
      for (const file of claudeFiles) {
        try {
          const content = fs.readFileSync(file, 'utf-8');
          fs.writeFileSync(file, content.replaceAll('Andy', name));
        } catch {}
      }
    }

    // Pull agent Docker image if needed
    await exec(`bash ${FIRST_BOOT_SCRIPT}`);

    // Ensure Docker is running
    await exec('systemctl start docker').catch(() => {});

    res.json({ status: 'ok' });
  } catch (err) {
    console.error('Setup failed:', err);
    res.status(500).json({ error: 'Setup failed', details: String(err) });
  }
});

// ── POST /channel ───────────────────────────────────────────────────────
// Add a channel, then start or restart NanoClaw.
app.post('/channel', async (req: Request, res: Response) => {
  const { name, config } = req.body;

  if (!name) {
    res.status(400).json({ error: 'Channel name is required' });
    return;
  }

  try {
    if (name === 'whatsapp') {
      // WhatsApp: start the standalone auth script for QR pairing
      if (whatsappAuthProcess) {
        res.json({ status: 'authenticating', message: 'WhatsApp auth already in progress' });
        return;
      }

      // Clean up previous auth state
      try { fs.unlinkSync(QR_DATA_PATH); } catch {}
      try { fs.unlinkSync(AUTH_STATUS_PATH); } catch {}

      whatsappAuthProcess = spawn('node', ['dist/whatsapp-auth.js'], {
        cwd: NANOCLAW_DIR,
        stdio: 'ignore',
        detached: true,
      });

      whatsappAuthProcess.on('exit', async (code) => {
        console.log(`whatsapp-auth exited with code ${code}`);
        whatsappAuthProcess = null;

        // If auth succeeded, start/restart NanoClaw
        if (fs.existsSync(AUTH_CREDS_PATH)) {
          try {
            await startOrRestartNanoclaw();
          } catch (err) {
            console.error('Failed to start NanoClaw after WhatsApp auth:', err);
          }
        }
      });

      res.json({ status: 'authenticating' });
    } else {
      // Token-based channel: write env vars to .env
      let env = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf-8') : '';
      const vars = channelToEnvVars(name, config);

      if (Object.keys(vars).length === 0) {
        res.status(400).json({ error: `Unknown channel: ${name}` });
        return;
      }

      for (const [key, value] of Object.entries(vars)) {
        env = setEnvLine(env, key, value);
      }
      fs.writeFileSync(ENV_PATH, env);

      // Start or restart NanoClaw to pick up the new channel
      await startOrRestartNanoclaw();

      res.json({ status: 'ok' });
    }
  } catch (err) {
    console.error('Channel add failed:', err);
    res.status(500).json({ error: 'Failed to add channel', details: String(err) });
  }
});

// ── GET /status ─────────────────────────────────────────────────────────
app.get('/status', async (_req: Request, res: Response) => {
  try {
    const running = await isServiceActive('nanoclaw');
    const channels = getConfiguredChannels();
    const agentName = getEnvValue('ASSISTANT_NAME') || 'Andy';
    const uptime = running && startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0;
    const channelStatus = readChannelStatus();

    res.json({ running, channels, agentName, uptime, channelStatus });
  } catch (err) {
    console.error('Status check failed:', err);
    res.status(500).json({ error: 'Status check failed' });
  }
});

// ── GET /qr ─────────────────────────────────────────────────────────────
app.get('/qr', (_req: Request, res: Response) => {
  try {
    // Check auth status first
    if (fs.existsSync(AUTH_STATUS_PATH)) {
      const status = fs.readFileSync(AUTH_STATUS_PATH, 'utf-8').trim();
      if (status === 'authenticated') {
        res.json({ qr: null, status: 'authenticated' });
        return;
      }
    }

    // Check for QR data
    if (fs.existsSync(QR_DATA_PATH)) {
      const qr = fs.readFileSync(QR_DATA_PATH, 'utf-8').trim();
      if (qr) {
        res.json({ qr, status: 'waiting' });
        return;
      }
    }

    res.json({ qr: null, status: whatsappAuthProcess ? 'connecting' : 'not_started' });
  } catch (err) {
    console.error('QR read failed:', err);
    res.json({ qr: null, status: 'not_started' });
  }
});

// ── POST /restart ───────────────────────────────────────────────────────
app.post('/restart', async (_req: Request, res: Response) => {
  try {
    await exec('systemctl restart nanoclaw');
    startedAt = Date.now();
    res.json({ status: 'ok' });
  } catch (err) {
    console.error('Restart failed:', err);
    res.status(500).json({ error: 'Restart failed', details: String(err) });
  }
});

// ── DELETE / ────────────────────────────────────────────────────────────
app.delete('/', async (_req: Request, res: Response) => {
  try {
    if (whatsappAuthProcess) {
      whatsappAuthProcess.kill();
      whatsappAuthProcess = null;
    }
    await exec('systemctl stop nanoclaw').catch(() => {});
    startedAt = null;
    res.json({ status: 'ok' });
  } catch (err) {
    console.error('Shutdown failed:', err);
    res.status(500).json({ error: 'Shutdown failed', details: String(err) });
  }
});

// ── Helpers ─────────────────────────────────────────────────────────────

async function startOrRestartNanoclaw(): Promise<void> {
  const running = await isServiceActive('nanoclaw');
  if (running) {
    await exec('systemctl restart nanoclaw');
  } else {
    await exec('systemctl start nanoclaw');
  }
  startedAt = Date.now();
}

function channelToEnvVars(name: string, config: unknown): Record<string, string> {
  switch (name) {
    case 'telegram':
      return { TELEGRAM_BOT_TOKEN: String(config) };
    case 'slack': {
      const slack = config as { botToken: string; appToken: string };
      return {
        SLACK_BOT_TOKEN: slack.botToken,
        SLACK_APP_TOKEN: slack.appToken,
      };
    }
    case 'discord':
      return { DISCORD_BOT_TOKEN: String(config) };
    default:
      return {};
  }
}

function setEnvLine(env: string, key: string, value: string): string {
  const regex = new RegExp(`^${key}=.*$`, 'm');
  const line = `${key}=${value}`;
  if (regex.test(env)) {
    return env.replace(regex, line);
  }
  return env.trimEnd() + '\n' + line + '\n';
}

function getEnvValue(key: string): string | undefined {
  try {
    const content = fs.readFileSync(ENV_PATH, 'utf-8');
    const match = content.match(new RegExp(`^${key}=(.*)$`, 'm'));
    return match?.[1]?.trim();
  } catch {
    return undefined;
  }
}

function getConfiguredChannels(): string[] {
  const channels: string[] = [];
  if (getEnvValue('TELEGRAM_BOT_TOKEN')) channels.push('telegram');
  if (getEnvValue('SLACK_BOT_TOKEN')) channels.push('slack');
  if (getEnvValue('DISCORD_BOT_TOKEN')) channels.push('discord');
  if (fs.existsSync(AUTH_CREDS_PATH)) channels.push('whatsapp');
  return channels;
}

function readChannelStatus(): Record<string, { status: string; error?: string }> | null {
  try {
    const content = fs.readFileSync(CHANNEL_STATUS_PATH, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

async function isServiceActive(service: string): Promise<boolean> {
  try {
    await exec(`systemctl is-active --quiet ${service}`);
    return true;
  } catch {
    return false;
  }
}

// ── Start ───────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Bootstrap API listening on port ${PORT}`);
});
