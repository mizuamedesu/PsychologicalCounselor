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
const runnerSharedSecret = requiredEnv("RUNNER_SHARED_SECRET");

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
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (message.channel.type !== ChannelType.DM) return;

  await handleDirectMessage(message);
});

client.on("error", (error) => console.error("discord client error", error));
client.on("warn", (warning) => console.warn("discord client warning", warning));

await client.login(token);

async function handleDirectMessage(message: Message): Promise<void> {
  const content = message.content.trim();
  if (!content) return;

  try {
    if ("sendTyping" in message.channel) {
      await message.channel.sendTyping();
    }
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

    const body = await response.json() as { content?: string; error?: string };
    if (!response.ok) {
      await message.reply(`処理に失敗しました: ${body.error ?? response.statusText}`);
      return;
    }

    await sendChunked(message, body.content || "空の応答でした。");
  } catch (error) {
    console.error("failed to handle direct message", error);
    await message.reply(`処理中に失敗しました: ${error instanceof Error ? error.message : String(error)}`);
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

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
