import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Message
} from "discord.js";

const token = requiredEnv("DISCORD_BOT_TOKEN");
const workerDmUrl = requiredEnv("WORKER_DM_URL");
const workerDmIngestUrl = process.env.WORKER_DM_INGEST_URL || new URL("/dm/ingest", workerDmUrl).toString();
const workerDmRespondUrl = process.env.WORKER_DM_RESPOND_URL || new URL("/dm/respond", workerDmUrl).toString();
const workerDmDueUrl = process.env.WORKER_DM_DUE_URL || new URL("/dm/due", workerDmUrl).toString();
const workerProactiveUrl = process.env.WORKER_PROACTIVE_URL || new URL("/proactive", workerDmUrl).toString();
const workerOrchestrateUrl = process.env.WORKER_ORCHESTRATE_URL || new URL("/orchestrate", workerDmUrl).toString();
const runnerSharedSecret = requiredEnv("RUNNER_SHARED_SECRET");
const proactivePollIntervalMs = numberEnv("PROACTIVE_POLL_INTERVAL_MS", 5 * 60_000);
const dueReplyPollIntervalMs = numberEnv("DUE_REPLY_POLL_INTERVAL_MS", 30_000);
const lifeOrchestrationIntervalMs = numberEnv("LIFE_ORCHESTRATION_INTERVAL_MS", 5 * 60_000);

type WorkerDmResponse = {
  content?: string;
  delayMs?: number;
  botUsername?: string;
  purgeDiscordHistory?: boolean;
  purgeLimit?: number;
  deleteTriggerMessage?: boolean;
  error?: string;
};

type ProactiveResponse = {
  messages?: Array<{
    channelId: string;
    content: string;
    delayMs?: number;
  }>;
  error?: string;
};

type DmIngestResponse = {
  accepted?: boolean;
  delayMs?: number;
  scheduledAt?: number;
  generation?: number;
  timingMode?: string;
  content?: string;
  immediate?: boolean;
  botUsername?: string;
  deleteTriggerMessage?: boolean;
  frozen?: boolean;
  error?: string;
};

type DmRespondResponse = {
  content?: string;
  skipped?: boolean;
  reason?: string;
  error?: string;
};

type DueRepliesResponse = {
  replies?: Array<{
    userId: string;
    channelId: string;
    generation: number;
    scheduledAt: number;
  }>;
  error?: string;
};

type OrchestrateResponse = {
  states?: Array<{
    discord_user_id: string;
    activity: string;
    availability_mode: string;
    next_tick_at: number;
  }>;
  botUsername?: string;
  error?: string;
};

type SendableChannel = {
  send(content: string): Promise<unknown>;
  sendTyping?: () => Promise<void>;
};

type PurgeableChannel = SendableChannel & {
  messages: {
    fetch(options: { limit: number; before?: string }): Promise<{
      size: number;
      values(): IterableIterator<Message>;
      last(): Message | undefined;
    }>;
  };
};

type DiscordPurgeReport = {
  scanned: number;
  botDeleted: number;
  userDeleted: number;
  botFailed: number;
  userFailed: number;
};

type DeleteReport = {
  attempted: boolean;
  deleted: boolean;
};

const pendingReplyTimers = new Map<string, ReturnType<typeof setTimeout>>();
const replyInFlight = new Set<string>();
let lastUsernameChange: { username: string; at: number } | null = null;

const client = new Client({
  intents: [
    GatewayIntentBits.DirectMessages
  ],
  partials: [
    Partials.Channel
  ]
});

client.once(Events.ClientReady, () => {
  console.log(`discord dm bot ready as ${client.user?.tag ?? "unknown"}`);
  setInterval(() => {
    void pollProactiveMessages();
  }, proactivePollIntervalMs);
  setInterval(() => {
    void pollDueReplies();
  }, dueReplyPollIntervalMs);
  setInterval(() => {
    void orchestrateLife();
  }, lifeOrchestrationIntervalMs);
  setTimeout(() => {
    void pollProactiveMessages();
  }, Math.min(proactivePollIntervalMs, 60_000));
  setTimeout(() => {
    void pollDueReplies();
  }, Math.min(dueReplyPollIntervalMs, 20_000));
  setTimeout(() => {
    void orchestrateLife(true);
  }, 5_000);
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (message.channel.type !== ChannelType.DM) return;

  void handleDirectMessage(message);
});

client.on("error", (error) => console.error("discord client error", error));
client.on("warn", (warning) => console.warn("discord client warning", warning));

await client.login(token);

async function handleDirectMessage(message: Message): Promise<void> {
  const content = message.content.trim();
  if (!content) return;

  try {
    if (isCommand(content)) {
      await handleCommandMessage(message, content);
      return;
    }

    const response = await fetch(workerDmIngestUrl, {
      method: "POST",
      headers: {
        "authorization": `Bearer ${runnerSharedSecret}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        userId: message.author.id,
        username: message.author.username,
        globalName: message.author.globalName,
        channelId: message.channel.id,
        messageId: message.id,
        content
      })
    });

    const body = await response.json() as DmIngestResponse;
    if (!response.ok) {
      await message.reply(`処理に失敗しました: ${body.error ?? response.statusText}`);
      return;
    }

    if (body.botUsername) {
      await applyBotUsername(body.botUsername);
    }
    if (body.content) {
      const deleteReport = body.deleteTriggerMessage
        ? await deleteTriggerMessage(message)
        : null;
      await waitWithTyping(message, body.delayMs ?? 0);
      await sendChunked(message, withDeleteReport(body.content, deleteReport));
      return;
    }
    if (body.frozen) return;
    if (body.generation === undefined) return;
    schedulePendingReply({
      userId: message.author.id,
      channelId: message.channel.id,
      generation: body.generation,
      delayMs: body.delayMs ?? 0
    });
  } catch (error) {
    console.error("failed to handle direct message", error);
    await message.reply(`処理中に失敗しました: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function handleCommandMessage(message: Message, content: string): Promise<void> {
  const response = await fetch(workerDmUrl, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${runnerSharedSecret}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      userId: message.author.id,
      username: message.author.username,
      globalName: message.author.globalName,
      channelId: message.channel.id,
      messageId: message.id,
      content
    })
  });

  const body = await response.json() as WorkerDmResponse;
  if (!response.ok) {
    await message.reply(`処理に失敗しました: ${body.error ?? response.statusText}`);
    return;
  }

  if (body.botUsername) {
    await applyBotUsername(body.botUsername);
  }
  const deleteReport = body.deleteTriggerMessage
    ? await deleteTriggerMessage(message)
    : null;
  const purgeReport = body.purgeDiscordHistory
    ? await purgeDiscordDmHistory(message, body.purgeLimit ?? 500)
    : null;
  await sendChunked(message, withDeleteReport(withPurgeReport(body.content || "空の応答でした。", purgeReport), deleteReport));
}

function schedulePendingReply(input: {
  userId: string;
  channelId: string;
  generation: number;
  delayMs: number;
}): void {
  const previous = pendingReplyTimers.get(input.channelId);
  if (previous) clearTimeout(previous);

  const timer = setTimeout(() => {
    pendingReplyTimers.delete(input.channelId);
    void sendScheduledReply(input);
  }, Math.max(0, Math.min(input.delayMs, 24 * 60 * 60_000)));

  pendingReplyTimers.set(input.channelId, timer);
}

async function pollDueReplies(): Promise<void> {
  try {
    const response = await fetch(workerDmDueUrl, {
      method: "POST",
      headers: {
        "authorization": `Bearer ${runnerSharedSecret}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ limit: 2 })
    });

    const body = await response.json() as DueRepliesResponse;
    if (!response.ok) {
      console.warn("due reply poll failed", body.error ?? response.statusText);
      return;
    }

    for (const reply of body.replies ?? []) {
      if (pendingReplyTimers.has(reply.channelId)) continue;
      void sendScheduledReply(reply);
    }
  } catch (error) {
    console.error("failed to poll due replies", error);
  }
}

async function sendScheduledReply(input: {
  userId: string;
  channelId: string;
  generation?: number;
}): Promise<void> {
  if (replyInFlight.has(input.channelId)) return;
  replyInFlight.add(input.channelId);
  try {
    const channel = await client.channels.fetch(input.channelId);
    if (!channel || !("send" in channel)) return;
    const sendable = channel as SendableChannel;
    const responsePromise = fetch(workerDmRespondUrl, {
      method: "POST",
      headers: {
        "authorization": `Bearer ${runnerSharedSecret}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        userId: input.userId,
        channelId: input.channelId,
        generation: input.generation
      })
    });

    await maintainTypingUntil(sendable, responsePromise);
    const response = await responsePromise;
    const body = await response.json() as DmRespondResponse;
    if (!response.ok) {
      console.warn("scheduled reply failed", body.error ?? response.statusText);
      return;
    }
    if (body.skipped || !body.content) return;
    await sendable.send(body.content);
  } catch (error) {
    console.error("failed to send scheduled reply", error);
  } finally {
    replyInFlight.delete(input.channelId);
  }
}

async function pollProactiveMessages(): Promise<void> {
  try {
    const response = await fetch(workerProactiveUrl, {
      method: "POST",
      headers: {
        "authorization": `Bearer ${runnerSharedSecret}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ limit: 1 })
    });

    const body = await response.json() as ProactiveResponse;
    if (!response.ok) {
      console.warn("proactive poll failed", body.error ?? response.statusText);
      return;
    }

    for (const item of body.messages ?? []) {
      const channel = await client.channels.fetch(item.channelId);
      if (!channel || !("send" in channel)) continue;
      const sendable = channel as SendableChannel;
      await waitWithChannelTyping(sendable, item.delayMs ?? 0);
      await sendable.send(item.content);
    }
  } catch (error) {
    console.error("failed to poll proactive messages", error);
  }
}

async function orchestrateLife(force = false): Promise<void> {
  try {
    const response = await fetch(workerOrchestrateUrl, {
      method: "POST",
      headers: {
        "authorization": `Bearer ${runnerSharedSecret}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ limit: 3, force })
    });

    const body = await response.json() as OrchestrateResponse;
    if (!response.ok) {
      console.warn("life orchestration failed", body.error ?? response.statusText);
      return;
    }
    if (body.botUsername) {
      await applyBotUsername(body.botUsername);
    }
  } catch (error) {
    console.error("failed to orchestrate life", error);
  }
}

async function sendChunked(message: Message, content: string): Promise<void> {
  const chunks = chunkDiscord(content);
  const channel = message.channel;
  for (const [index, chunk] of chunks.entries()) {
    if (index === 0) await message.reply(chunk);
    else if ("send" in channel) await channel.send(chunk);
  }
}

function chunkDiscord(content: string): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < content.length; index += 1900) {
    chunks.push(content.slice(index, index + 1900));
  }
  return chunks.length ? chunks : [" "];
}

async function waitWithTyping(message: Message, delayMs: number): Promise<void> {
  await waitWithChannelTyping(message.channel as SendableChannel, delayMs);
}

async function waitWithChannelTyping(
  channel: SendableChannel,
  delayMs: number
): Promise<void> {
  const boundedDelay = Math.max(0, Math.min(delayMs, 15 * 60_000));
  const typingLeadMs = Math.min(18_000, Math.max(2_000, Math.floor(boundedDelay / 3)));
  const silentWait = Math.max(0, boundedDelay - typingLeadMs);

  if (silentWait > 0) await sleep(silentWait);
  if (channel.sendTyping) {
    const endAt = Date.now() + typingLeadMs;
    do {
      await channel.sendTyping();
      const remaining = endAt - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(8_000, remaining));
    } while (Date.now() < endAt);
  } else if (typingLeadMs > 0) {
    await sleep(typingLeadMs);
  }
}

async function maintainTypingUntil(channel: SendableChannel, promise: Promise<unknown>): Promise<void> {
  let done = false;
  promise.finally(() => {
    done = true;
  }).catch(() => undefined);
  while (!done) {
    if (channel.sendTyping) await channel.sendTyping();
    await sleep(8_000);
  }
}

async function deleteTriggerMessage(message: Message): Promise<DeleteReport> {
  try {
    await message.delete();
    return { attempted: true, deleted: true };
  } catch {
    return { attempted: true, deleted: false };
  }
}

async function purgeDiscordDmHistory(message: Message, limit: number): Promise<DiscordPurgeReport> {
  const report: DiscordPurgeReport = {
    scanned: 0,
    botDeleted: 0,
    userDeleted: 0,
    botFailed: 0,
    userFailed: 0
  };
  const channel = message.channel as unknown as PurgeableChannel;
  if (!channel.messages?.fetch) return report;

  let before: string | undefined;
  const max = Math.max(1, Math.min(limit, 2_000));
  while (report.scanned < max) {
    const batch = await channel.messages.fetch({
      limit: Math.min(100, max - report.scanned),
      before
    });
    if (batch.size === 0) break;

    for (const item of batch.values()) {
      report.scanned += 1;
      const isBotMessage = item.author.id === client.user?.id;
      try {
        await item.delete();
        if (isBotMessage) report.botDeleted += 1;
        else report.userDeleted += 1;
        await sleep(350);
      } catch {
        if (isBotMessage) report.botFailed += 1;
        else report.userFailed += 1;
      }
    }

    before = batch.last()?.id;
    if (!before || batch.size < 100) break;
  }

  return report;
}

function withDeleteReport(content: string, report: DeleteReport | null): string {
  if (!report || report.deleted) return content;
  return [
    content,
    "",
    "入力メッセージの削除も試しましたが、Discordに拒否されました。今後のペルソナ設定は `/persona set` を使うと通常DM履歴に本文を残さず設定できます。"
  ].join("\n");
}

function withPurgeReport(content: string, report: DiscordPurgeReport | null): string {
  if (!report) return content;
  return [
    content,
    "",
    [
      `Discord履歴掃除: ${report.scanned}件確認`,
      `Bot削除 ${report.botDeleted}件`,
      `ユーザー削除 ${report.userDeleted}件`,
      report.botFailed ? `Bot削除失敗 ${report.botFailed}件` : undefined,
      report.userFailed ? `ユーザー削除失敗 ${report.userFailed}件` : undefined
    ].filter(Boolean).join(" / "),
    report.userFailed
      ? "ユーザー側のDMはDiscordのBot権限では消せない場合があります。その分はDiscordクライアント側で手動削除が必要です。"
      : undefined
  ].filter(Boolean).join("\n");
}

async function applyBotUsername(username: string): Promise<void> {
  const next = sanitizeDiscordUsername(username);
  if (!next || !client.user) return;
  if (client.user.username === next) return;
  if (lastUsernameChange?.username === next) return;
  if (lastUsernameChange && Date.now() - lastUsernameChange.at < 30 * 60_000) {
    console.warn(`skip username change to ${next}: changed too recently`);
    return;
  }

  try {
    await client.user.setUsername(next);
    lastUsernameChange = { username: next, at: Date.now() };
    console.log(`discord bot username changed to ${next}`);
  } catch (error) {
    console.warn("failed to change discord bot username", error);
  }
}

function sanitizeDiscordUsername(value: string): string | null {
  const sanitized = value
    .replace(/[@#:`]/g, "")
    .replace(/discord/ig, "d")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 32);
  if (sanitized.length < 2) return null;
  const lowered = sanitized.toLowerCase();
  if (lowered === "everyone" || lowered === "here") return `${sanitized}_`.slice(0, 32);
  return sanitized;
}

function isCommand(content: string): boolean {
  return /^[/!](login|status|memory|forget|persona|worldfreeze)\b/i.test(content.trim());
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function numberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
