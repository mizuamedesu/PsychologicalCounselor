import { Container } from "@cloudflare/containers";
import {
  DiscordInteractionResponseType,
  DiscordInteractionType,
  deferredMessage,
  editOriginalInteraction,
  getOption,
  immediateMessage,
  interactionUserId,
  isOwner,
  jsonResponse,
  readVerifiedDiscordInteraction
} from "./discord";
import {
  buildMemoryContext,
  forgetAllMemory,
  memoryStats,
  searchMemoryForDisplay,
  storeConversationMemory
} from "./memory";
import { buildCounselorPrompt } from "./prompt";
import { callRunner, runCodexChat } from "./runner";
import type { DiscordInteraction, Env } from "./types";

export class CodexRunnerContainer extends Container {
  defaultPort = 8789;
  requiredPorts = [8789];
  sleepAfter = "30m";
  enableInternet = true;
  pingEndpoint = "localhost/health";
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse({
        ok: true,
        runnerBackend: env.RUNNER_BACKEND || "container"
      });
    }

    if (request.method === "POST" && url.pathname === "/discord") {
      return handleDiscordInteraction(request, env, ctx);
    }

    return new Response("Not found", { status: 404 });
  }
} satisfies ExportedHandler<Env>;

async function handleDiscordInteraction(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const interaction = await readVerifiedDiscordInteraction(request, env.DISCORD_PUBLIC_KEY);
  if (!interaction) return new Response("bad request signature", { status: 401 });

  if (interaction.type === DiscordInteractionType.Ping) {
    return jsonResponse({ type: DiscordInteractionResponseType.Pong });
  }

  if (interaction.type !== DiscordInteractionType.ApplicationCommand || !interaction.data) {
    return immediateMessage("未対応のDiscord interactionです。");
  }

  if (!isOwner(interaction, env.OWNER_DISCORD_USER_ID)) {
    return immediateMessage("このbotはprivate運用なので、ownerだけが使えます。");
  }

  const commandName = interaction.data.name;

  if (commandName === "chat") {
    const isPrivate = getOption<boolean>(interaction.data.options, "private") ?? true;
    ctx.waitUntil(handleChat(interaction, env));
    return deferredMessage(isPrivate);
  }

  if (commandName === "login") {
    ctx.waitUntil(handleLogin(interaction, env));
    return deferredMessage(true);
  }

  if (commandName === "status") {
    ctx.waitUntil(handleStatus(interaction, env));
    return deferredMessage(true);
  }

  if (commandName === "memory") {
    ctx.waitUntil(handleMemorySearch(interaction, env));
    return deferredMessage(true);
  }

  if (commandName === "forget") {
    ctx.waitUntil(handleForget(interaction, env));
    return deferredMessage(true);
  }

  return immediateMessage("知らないコマンドです。");
}

async function handleChat(interaction: DiscordInteraction, env: Env): Promise<void> {
  const userId = interactionUserId(interaction);
  const message = getOption<string>(interaction.data?.options, "message")?.trim();

  if (!userId || !message) {
    await editOriginalInteraction(env.DISCORD_APPLICATION_ID, interaction.token, "messageが空です。");
    return;
  }

  try {
    const memory = await buildMemoryContext(env, userId, message);
    const prompt = buildCounselorPrompt({
      userMessage: message,
      memory,
      language: env.COUNSELOR_LANGUAGE || "ja",
      nowIso: new Date().toISOString()
    });

    const response = await runCodexChat(env, {
      prompt,
      model: env.CODEX_MODEL || undefined
    });

    const text = response.text.trim() || "うまく言葉にできませんでした。もう一度だけ送ってください。";
    await editOriginalInteraction(env.DISCORD_APPLICATION_ID, interaction.token, text);
    await storeConversationMemory({
      env,
      userId,
      channelId: interaction.channel_id,
      interactionId: interaction.id,
      userMessage: message,
      assistantMessage: text
    });
  } catch (error) {
    console.error(error);
    await editOriginalInteraction(
      env.DISCORD_APPLICATION_ID,
      interaction.token,
      `処理中に失敗しました。\n\`${error instanceof Error ? error.message : String(error)}\``
    );
  }
}

async function handleLogin(interaction: DiscordInteraction, env: Env): Promise<void> {
  try {
    const result = await callRunner<Record<string, unknown>>(env, "/auth/start", {});
    await editOriginalInteraction(env.DISCORD_APPLICATION_ID, interaction.token, formatAuthStart(result));
  } catch (error) {
    console.error(error);
    await editOriginalInteraction(
      env.DISCORD_APPLICATION_ID,
      interaction.token,
      `login開始に失敗しました。\n\`${error instanceof Error ? error.message : String(error)}\``
    );
  }
}

async function handleStatus(interaction: DiscordInteraction, env: Env): Promise<void> {
  const userId = interactionUserId(interaction);
  if (!userId) return;

  try {
    const [auth, stats] = await Promise.all([
      callRunner<Record<string, unknown>>(env, "/auth/status"),
      memoryStats(env, userId)
    ]);

    await editOriginalInteraction(
      env.DISCORD_APPLICATION_ID,
      interaction.token,
      [`runner: ${env.RUNNER_BACKEND || "container"}`, formatObject(auth), stats].join("\n\n")
    );
  } catch (error) {
    console.error(error);
    await editOriginalInteraction(
      env.DISCORD_APPLICATION_ID,
      interaction.token,
      `status取得に失敗しました。\n\`${error instanceof Error ? error.message : String(error)}\``
    );
  }
}

async function handleMemorySearch(interaction: DiscordInteraction, env: Env): Promise<void> {
  const userId = interactionUserId(interaction);
  const query = getOption<string>(interaction.data?.options, "query")?.trim();
  if (!userId || !query) {
    await editOriginalInteraction(env.DISCORD_APPLICATION_ID, interaction.token, "queryが空です。");
    return;
  }

  try {
    const result = await searchMemoryForDisplay(env, userId, query);
    await editOriginalInteraction(env.DISCORD_APPLICATION_ID, interaction.token, result);
  } catch (error) {
    console.error(error);
    await editOriginalInteraction(
      env.DISCORD_APPLICATION_ID,
      interaction.token,
      `memory検索に失敗しました。\n\`${error instanceof Error ? error.message : String(error)}\``
    );
  }
}

async function handleForget(interaction: DiscordInteraction, env: Env): Promise<void> {
  const userId = interactionUserId(interaction);
  const confirm = getOption<boolean>(interaction.data?.options, "confirm") ?? false;
  if (!userId) return;
  if (!confirm) {
    await editOriginalInteraction(
      env.DISCORD_APPLICATION_ID,
      interaction.token,
      "`confirm:true` を付けるとD1とVectorizeの記憶を全削除します。"
    );
    return;
  }

  try {
    const deleted = await forgetAllMemory(env, userId);
    await editOriginalInteraction(env.DISCORD_APPLICATION_ID, interaction.token, `${deleted}件の記憶を削除しました。`);
  } catch (error) {
    console.error(error);
    await editOriginalInteraction(
      env.DISCORD_APPLICATION_ID,
      interaction.token,
      `forgetに失敗しました。\n\`${error instanceof Error ? error.message : String(error)}\``
    );
  }
}

function formatAuthStart(value: Record<string, unknown>): string {
  if (value.status === "already_authenticated") {
    return "Codexはすでにログイン済みです。";
  }
  if (value.status === "pending" || value.status === "started") {
    return [
      "Codex device loginを開始しました。",
      value.verificationUri ? `URL: ${value.verificationUri}` : undefined,
      value.userCode ? `code: \`${value.userCode}\`` : undefined,
      "ブラウザで認証が終わったら `/status` で確認できます。"
    ].filter(Boolean).join("\n");
  }
  return formatObject(value);
}

function formatObject(value: unknown): string {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}
