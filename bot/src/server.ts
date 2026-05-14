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
const runnerSharedSecret = requiredEnv("RUNNER_SHARED_SECRET");
const proactivePollIntervalMs = numberEnv("PROACTIVE_POLL_INTERVAL_MS", 5 * 60_000);
const dueReplyPollIntervalMs = numberEnv("DUE_REPLY_POLL_INTERVAL_MS", 30_000);

type WorkerDmResponse = {
  content?: string;
  delayMs?: number;
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

type SendableChannel = {
  send(content: string): Promise<unknown>;
  sendTyping?: () => Promise<void>;
};

const pendingReplyTimers = new Map<string, ReturnType<typeof setTimeout>>();
const replyInFlight = new Set<string>();

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
  setTimeout(() => {
    void pollProactiveMessages();
  }, Math.min(proactivePollIntervalMs, 60_000));
  setTimeout(() => {
    void pollDueReplies();
  }, Math.min(dueReplyPollIntervalMs, 20_000));
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

  await sendChunked(message, body.content || "空の応答でした。");
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

function isCommand(content: string): boolean {
  return /^[/!](login|status|memory|forget)\b/i.test(content.trim());
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
