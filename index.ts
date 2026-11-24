import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import { Bot, webhookCallback } from "grammy";
import type { UserFromGetMe } from "grammy/types";

type BotState = "not_configured" | "starting" | "running" | "failed";

const port = parseInt(process.env.PORT || "3000", 10);
const rawBotToken = process.env.BOT_TOKEN?.trim() || "";
const rawAppUrl = process.env.APP_URL?.trim() || "";

let botState: BotState = (!rawBotToken || !rawAppUrl) ? "not_configured" : "starting";
let botError = "";
let botInfo: UserFromGetMe | null = null;
let webhookHandler: ((req: IncomingMessage, res: ServerResponse) => Promise<unknown>) | null = null;

// Read installed grammY version from package metadata
function getGrammyVersion(): string {
  try {
    const pkgUrl = new URL("../package.json", import.meta.resolve("grammy"));
    const pkg = JSON.parse(fs.readFileSync(pkgUrl, "utf-8"));
    return typeof pkg.version === "string" ? pkg.version : "1.48.0";
  } catch {
    return "1.48.0";
  }
}

const grammyVersion = getGrammyVersion();

// Escape HTML special characters for safe output
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

let webhookSecret = "";
if (rawBotToken) {
  webhookSecret = crypto.createHash("sha256").update(rawBotToken).digest("hex");
}

// Redact secret tokens from logs and error messages
function sanitize(msg: string): string {
  let result = msg;
  if (rawBotToken) {
    result = result.split(rawBotToken).join("[REDACTED]");
  }
  if (webhookSecret) {
    result = result.split(webhookSecret).join("[REDACTED]");
  }
  return result;
}

const START_REPLY =
  "Hello world! I am a bot built with grammY. Send me any text and I will repeat it.";

// Initialize bot and register webhook if credentials are provided
if (botState === "starting") {
  (async () => {
    try {
      const normalizedAppUrl = rawAppUrl.replace(/\/+$/, "");
      const webhookUrl = `${normalizedAppUrl}/webhook`;

      const bot = new Bot(rawBotToken);

      // Handle handler errors within boundary so Telegram receives 200
      const boundary = bot.errorBoundary((err) => {
        console.error("Bot error:", sanitize(err.message || String(err)));
      });

      boundary.command("start", async (ctx) => {
        await ctx.reply(START_REPLY);
      });

      boundary.on("message:text", async (ctx) => {
        const text = ctx.message.text;
        if (text.startsWith("/start")) {
          await ctx.reply(START_REPLY);
          return;
        }
        await ctx.reply(`You said: ${text}`);
      });

      await bot.init();
      await bot.api.setWebhook(webhookUrl, { secret_token: webhookSecret });

      botInfo = bot.botInfo;
      webhookHandler = webhookCallback(bot, "http", { secretToken: webhookSecret });
      botState = "running";
      console.log(`Bot @${botInfo.username} is running`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      botError = sanitize(message);
      botState = "failed";
      console.error("The bot did not start:", botError);
    }
  })();
}

// Render HTML page
function renderHtml(): string {
  let statusHtml = "";
  if (botState === "not_configured") {
    statusHtml = "<p>Set the BOT_TOKEN and APP_URL environment variables to start the bot.</p>";
  } else if (botState === "starting") {
    statusHtml = "<p>The bot is starting.</p>";
  } else if (botState === "running" && botInfo?.username) {
    const username = escapeHtml(botInfo.username);
    statusHtml = `<p>Bot @${username} is running.</p><p><a href="https://t.me/${username}" target="_blank" rel="noopener noreferrer">Open in Telegram</a></p>`;
  } else {
    statusHtml = `<p>The bot did not start: ${escapeHtml(botError)}</p>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>grammY</title>
  <style>
    body {
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      line-height: 1.5;
      margin: 0;
      padding: 48px 24px;
      color: #111;
      background: #fff;
    }
    main {
      max-width: 640px;
      margin: 0 auto;
    }
    h1 {
      margin: 0 0 16px;
      font-size: 28px;
    }
    p {
      margin: 8px 0;
    }
    a {
      color: #0066cc;
      text-decoration: none;
    }
    a:hover {
      text-decoration: underline;
    }
  </style>
</head>
<body>
  <main>
    <h1>Hello world</h1>
    <p>grammY: ${escapeHtml(grammyVersion)}</p>
    <p>Node.js: ${escapeHtml(process.version)}</p>
    ${statusHtml}
  </main>
</body>
</html>`;
}

// HTTP request router
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  if (req.method === "GET" && pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderHtml());
    return;
  }

  if (req.method === "POST" && pathname === "/webhook") {
    if (botState !== "running" || !webhookHandler) {
      res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Service Unavailable");
      return;
    }

    try {
      await webhookHandler(req, res);
    } catch (err: unknown) {
      console.error("Webhook processing error:", sanitize(err instanceof Error ? err.message : String(err)));
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Internal Server Error");
      }
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not Found");
});

// Start listening immediately
server.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});

// Graceful shutdown on termination signals
function shutdown() {
  server.close(() => {
    process.exit(0);
  });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
