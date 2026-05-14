import { existsSync, readFileSync } from "node:fs";

loadDotEnv(".env");

const token = requiredEnv("DISCORD_BOT_TOKEN");
const applicationId = requiredEnv("DISCORD_APPLICATION_ID");
const guildId = process.env.DISCORD_GUILD_ID;
const userInstallOnly = process.env.DISCORD_USER_INSTALL_ONLY !== "false";

const commands = withInstallContext([
  {
    name: "chat",
    description: "心理カウンセラーbotに話す",
    type: 1,
    options: [
      {
        name: "message",
        description: "話したいこと",
        type: 3,
        required: true
      },
      {
        name: "private",
        description: "自分だけに見える返信にする",
        type: 5,
        required: false
      }
    ]
  },
  {
    name: "login",
    description: "Codexのdevice codeログインを開始する",
    type: 1
  },
  {
    name: "status",
    description: "Codexログイン状態と記憶数を確認する",
    type: 1
  },
  {
    name: "memory",
    description: "長期記憶を検索する",
    type: 1,
    options: [
      {
        name: "query",
        description: "検索語",
        type: 3,
        required: true
      }
    ]
  },
  {
    name: "forget",
    description: "記憶を全削除する",
    type: 1,
    options: [
      {
        name: "confirm",
        description: "trueで本当に削除する",
        type: 5,
        required: true
      }
    ]
  }
]);

const route = guildId
  ? `/applications/${applicationId}/guilds/${guildId}/commands`
  : `/applications/${applicationId}/commands`;

const response = await fetch(`https://discord.com/api/v10${route}`, {
  method: "PUT",
  headers: {
    "authorization": `Bot ${token}`,
    "content-type": "application/json"
  },
  body: JSON.stringify(commands)
});

if (!response.ok) {
  throw new Error(`Command registration failed: ${response.status} ${await response.text()}`);
}

console.log(await response.json());

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function withInstallContext<T extends Array<Record<string, unknown>>>(items: T): T {
  if (guildId || !userInstallOnly) return items;

  return items.map((command) => ({
    ...command,
    // USER_INSTALL: install the app to your Discord account rather than a server.
    integration_types: [1],
    // BOT_DM + PRIVATE_CHANNEL: expose commands in DMs with the app and private channels.
    contexts: [1, 2]
  })) as unknown as T;
}

function loadDotEnv(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    if (process.env[key]) continue;
    process.env[key] = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
  }
}
