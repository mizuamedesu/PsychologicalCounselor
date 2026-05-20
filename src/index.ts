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
  isOwnerIdentity,
  jsonResponse,
  readVerifiedDiscordInteraction
} from "./discord";
import {
  buildMemoryContext,
  forgetAllMemory,
  memoryStats,
  searchMemoryForDisplay,
  storeAssistantMemory,
  storeConversationMemory
} from "./memory";
import { buildCounselorPrompt, buildProactivePrompt } from "./prompt";
import { buildWorldContext } from "./world";
import {
  formatWorldFreezeStatus,
  getWorldFreezeState,
  isWorldFrozen,
  parseWorldFreezeMode,
  setWorldFrozen
} from "./worldFreeze";
import {
  buildPersonaContext,
  ensurePersonaProfile,
  expandDuePersonaWorlds,
  getPersonaProfile,
  formatPersonaStatus,
  initializePersonaFromSeed,
  looksLikePersonaSeed,
  personaBotUsername,
  personaNeedsSeed,
  personaSetupPrompt
} from "./persona";
import { callRunner, runCodexChat } from "./runner";
import {
  formatLifeContext,
  getBotLifeState,
  getOrCreateBotLifeState,
  orchestrateLife
} from "./life";
import {
  buildPendingReplyContext,
  formatTimelineContext,
  getDuePendingReplies,
  getDueProactiveStates,
  ingestIncomingMessage,
  markAssistantReplied,
  markPendingReplySent,
  markProactiveSent,
  prepareIncomingTimeline,
  proactiveDelayMs
} from "./timeline";
import type {
  DmIngestResponse,
  DmRespondRequest,
  DmRespondResponse,
  DueRepliesResponse,
  DiscordDmRequest,
  DiscordDmResponse,
  DiscordInteraction,
  Env,
  OrchestrateRequest,
  OrchestrateResponse,
  ProactiveRequest,
  ProactiveResponse
} from "./types";

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

    if (request.method === "POST" && url.pathname === "/dm/ingest") {
      return handleDiscordDmIngest(request, env);
    }

    if (request.method === "POST" && url.pathname === "/dm/respond") {
      return handleDiscordDmRespond(request, env);
    }

    if (request.method === "POST" && url.pathname === "/dm/due") {
      return handleDiscordDmDue(request, env);
    }

    if (request.method === "POST" && url.pathname === "/dm") {
      return handleDiscordDm(request, env);
    }

    if (request.method === "POST" && url.pathname === "/proactive") {
      return handleProactive(request, env);
    }

    if (request.method === "POST" && url.pathname === "/orchestrate") {
      return handleOrchestrate(request, env);
    }

    return new Response("Not found", { status: 404 });
  }
} satisfies ExportedHandler<Env>;

async function handleDiscordDm(request: Request, env: Env): Promise<Response> {
  if (!isRunnerAuthorized(request, env)) {
    return jsonResponse({ error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json<DiscordDmRequest>();
  const content = body.content?.trim();
  if (!body.userId || !content) {
    return jsonResponse({ error: "userId and content are required" }, { status: 400 });
  }

  if (!isOwnerIdentity({
    userId: body.userId,
    usernames: [body.username, body.globalName],
    ownerId: env.OWNER_DISCORD_USER_ID,
    ownerUsername: env.OWNER_DISCORD_USERNAME
  })) {
    return jsonResponse({ error: "forbidden" }, { status: 403 });
  }

  const command = parseDmCommand(content);
  try {
    if (command.name === "login") {
      const result = await callRunner<Record<string, unknown>>(env, "/auth/start", {});
      const profile = await ensurePersonaProfile(env, body.userId);
      return jsonResponse({
        content: appendPersonaSetup(formatAuthStart(result), profile.status !== "active")
      });
    }

    if (command.name === "status") {
      const [auth, stats, persona, freeze] = await Promise.all([
        callRunner<Record<string, unknown>>(env, "/auth/status"),
        memoryStats(env, body.userId),
        formatPersonaStatus(env, body.userId),
        getWorldFreezeState(env, body.userId)
      ]);
      return jsonResponse({
        content: [
          `runner: ${env.RUNNER_BACKEND || "container"}`,
          formatAuthStatus(auth),
          stats,
          persona,
          formatWorldFreezeStatus(freeze)
        ].join("\n\n")
      });
    }

    if (command.name === "memory") {
      if (!command.argument) return jsonResponse({ content: "検索語を続けてください。例: `/memory 最近の不安`" });
      return jsonResponse({ content: await searchMemoryForDisplay(env, body.userId, command.argument) });
    }

    if (command.name === "forget") {
      if (command.argument !== "confirm") {
        return jsonResponse({ content: "`/forget confirm` でD1とVectorizeの記憶を全削除します。" });
      }
      const deleted = await forgetAllMemory(env, body.userId);
      return jsonResponse({ content: `${deleted}件の記憶を削除しました。` });
    }

    if (command.name === "persona") {
      return jsonResponse(await handlePersonaCommand(env, body.userId, command.argument));
    }

    if (command.name === "worldfreeze") {
      return jsonResponse({ content: await handleWorldFreezeCommand(env, body.userId, command.argument) });
    }

    if (await personaNeedsSeed(env, body.userId)) {
      if (!looksLikePersonaSeed(content)) {
        return jsonResponse({ content: personaSetupPrompt() });
      }
      await resetAllUserData(env, body.userId);
      const persona = await initializePersonaFromSeed({
        env,
        userId: body.userId,
        seed: content
      });
      return jsonResponse({
        content: [
          "決めた。",
          "この子として時間を進めていくね。"
        ].join("\n"),
        botUsername: personaBotUsername(persona.profile),
        deleteTriggerMessage: true
      } satisfies DiscordDmResponse);
    }

    const reply = await generateCounselorReply({
      env,
      userId: body.userId,
      channelId: body.channelId,
      interactionId: body.messageId,
      message: content,
      useTimeline: true
    });
    return jsonResponse({ content: reply.text, delayMs: reply.delayMs } satisfies DiscordDmResponse);
  } catch (error) {
    console.error(error);
    return jsonResponse({
      error: error instanceof Error ? error.message : String(error)
    }, { status: 500 });
  }
}

async function handleDiscordDmIngest(request: Request, env: Env): Promise<Response> {
  if (!isRunnerAuthorized(request, env)) {
    return jsonResponse({ error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json<DiscordDmRequest>();
  const content = body.content?.trim();
  if (!body.userId || !body.channelId || !body.messageId || !content) {
    return jsonResponse({ error: "userId, channelId, messageId and content are required" }, { status: 400 });
  }

  if (!isOwnerIdentity({
    userId: body.userId,
    usernames: [body.username, body.globalName],
    ownerId: env.OWNER_DISCORD_USER_ID,
    ownerUsername: env.OWNER_DISCORD_USERNAME
  })) {
    return jsonResponse({ error: "forbidden" }, { status: 403 });
  }

  const command = parseDmCommand(content);
  if (command.name !== null) {
    return jsonResponse({
      accepted: true,
      delayMs: 0,
      scheduledAt: Date.now(),
      generation: 0,
      timingMode: "command"
    } satisfies DmIngestResponse);
  }

  if (await isWorldFrozen(env, body.userId)) {
    return jsonResponse({
      accepted: true,
      delayMs: 0,
      scheduledAt: Date.now(),
      generation: 0,
      timingMode: "worldfreeze",
      frozen: true
    } satisfies DmIngestResponse);
  }

  if (await personaNeedsSeed(env, body.userId)) {
    if (!looksLikePersonaSeed(content)) {
      return jsonResponse({
        accepted: true,
        delayMs: 800,
        scheduledAt: Date.now() + 800,
        generation: 0,
        timingMode: "persona_setup",
        immediate: true,
        content: [
          "うん、話す前にまず私のペルソナを固めたい。",
          "",
          personaSetupPrompt()
        ].join("\n")
      } satisfies DmIngestResponse);
    }

    await resetAllUserData(env, body.userId);
    const persona = await initializePersonaFromSeed({
      env,
      userId: body.userId,
      seed: content
    });
    const delayMs = randomImmediateDelay();
    return jsonResponse({
      accepted: true,
      delayMs,
      scheduledAt: Date.now() + delayMs,
      generation: 0,
      timingMode: "persona_setup",
      immediate: true,
      botUsername: personaBotUsername(persona.profile),
      deleteTriggerMessage: true,
      content: [
        "決めた。",
        "この子として時間を進めていくね。足りない過去の出来事や癖は、会話と時間経過に合わせて少しずつ増やしていく。"
      ].join("\n")
    } satisfies DmIngestResponse);
  }

  const plan = await ingestIncomingMessage({
    env,
    userId: body.userId,
    channelId: body.channelId,
    messageId: body.messageId,
    message: content
  });

  return jsonResponse({
    accepted: true,
    delayMs: plan.delayMs,
    scheduledAt: plan.scheduledAt,
    generation: plan.generation,
    timingMode: plan.timingMode
  } satisfies DmIngestResponse);
}

async function handleDiscordDmRespond(request: Request, env: Env): Promise<Response> {
  if (!isRunnerAuthorized(request, env)) {
    return jsonResponse({ error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json<DmRespondRequest>();
  if (!body.userId || !body.channelId) {
    return jsonResponse({ error: "userId and channelId are required" }, { status: 400 });
  }
  if (!isOwnerIdentity({
    userId: body.userId,
    ownerId: env.OWNER_DISCORD_USER_ID,
    ownerUsername: env.OWNER_DISCORD_USERNAME
  })) {
    return jsonResponse({ error: "forbidden" }, { status: 403 });
  }

  try {
    if (await isWorldFrozen(env, body.userId) && !body.force) {
      return jsonResponse({
        skipped: true,
        reason: "worldfreeze is on"
      } satisfies DmRespondResponse);
    }

    const pending = await buildPendingReplyContext({
      env,
      userId: body.userId,
      channelId: body.channelId,
      generation: body.generation,
      force: body.force
    });
    if (!pending.ready) {
      return jsonResponse({
        skipped: true,
        reason: pending.skippedReason
      } satisfies DmRespondResponse);
    }

    const reply = await generateCounselorReply({
      env,
      userId: body.userId,
      channelId: body.channelId,
      interactionId: pending.messages.map((message) => message.message_id).join(","),
      message: pending.combinedMessage,
      timeline: pending.timeline,
      useTimeline: false
    });

    await markPendingReplySent({
      env,
      userId: body.userId,
      channelId: body.channelId,
      messageIds: pending.messages.map((message) => message.id)
    });

    return jsonResponse({ content: reply.text } satisfies DmRespondResponse);
  } catch (error) {
    console.error(error);
    return jsonResponse({
      error: error instanceof Error ? error.message : String(error)
    }, { status: 500 });
  }
}

async function handleDiscordDmDue(request: Request, env: Env): Promise<Response> {
  if (!isRunnerAuthorized(request, env)) {
    return jsonResponse({ error: "unauthorized" }, { status: 401 });
  }

  const body: ProactiveRequest = await request.json<ProactiveRequest>().catch(() => ({}));
  if (env.OWNER_DISCORD_USER_ID && await isWorldFrozen(env, env.OWNER_DISCORD_USER_ID)) {
    return jsonResponse({ replies: [], worldFrozen: true } satisfies DueRepliesResponse);
  }
  const replies = await getDuePendingReplies(env, Math.max(1, Math.min(body.limit ?? 2, 5)));
  return jsonResponse({ replies } satisfies DueRepliesResponse);
}

async function handleProactive(request: Request, env: Env): Promise<Response> {
  if (!isRunnerAuthorized(request, env)) {
    return jsonResponse({ error: "unauthorized" }, { status: 401 });
  }

  const body: ProactiveRequest = await request.json<ProactiveRequest>().catch(() => ({}));
  if (env.OWNER_DISCORD_USER_ID && await isWorldFrozen(env, env.OWNER_DISCORD_USER_ID)) {
    return jsonResponse({ messages: [], worldFrozen: true } satisfies ProactiveResponse);
  }
  const limit = Math.max(1, Math.min(body.limit ?? 1, 3));
  const now = Date.now();
  const states = await getDueProactiveStates(env, limit, now);
  const messages = [];

  for (const state of states) {
    if (!state.channel_id) continue;
    try {
      const content = await generateProactiveMessage(env, state, now);
      messages.push({
        userId: state.discord_user_id,
        channelId: state.channel_id,
        content,
        delayMs: proactiveDelayMs()
      });
    } catch (error) {
      console.error("proactive generation failed", error);
      await markProactiveSent({ env, state, now });
    }
  }

  return jsonResponse({ messages } satisfies ProactiveResponse);
}

async function handleOrchestrate(request: Request, env: Env): Promise<Response> {
  if (!isRunnerAuthorized(request, env)) {
    return jsonResponse({ error: "unauthorized" }, { status: 401 });
  }

  const body: OrchestrateRequest = await request.json<OrchestrateRequest>().catch(() => ({}));
  if (env.OWNER_DISCORD_USER_ID && await isWorldFrozen(env, env.OWNER_DISCORD_USER_ID)) {
    return jsonResponse({
      states: [],
      personaExpansions: [],
      worldFrozen: true
    } satisfies OrchestrateResponse);
  }

  const states = await orchestrateLife({
    env,
    limit: Math.max(1, Math.min(body.limit ?? 3, 5)),
    force: body.force ?? false
  });
  const personaExpansions = await expandDuePersonaWorlds({
    env,
    limit: Math.max(1, Math.min(body.limit ?? 3, 5)),
    force: body.force ?? false
  });
  const profile = env.OWNER_DISCORD_USER_ID
    ? await getPersonaProfile(env, env.OWNER_DISCORD_USER_ID)
    : null;
  const botUsername = profile?.status === "active" ? personaBotUsername(profile) : undefined;

  return jsonResponse({ states, personaExpansions, botUsername } satisfies OrchestrateResponse);
}

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

  if (!isOwner(interaction, env.OWNER_DISCORD_USER_ID, env.OWNER_DISCORD_USERNAME)) {
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

  if (commandName === "worldfreeze") {
    ctx.waitUntil(handleWorldFreezeInteraction(interaction, env));
    return deferredMessage(true);
  }

  if (commandName === "memory") {
    ctx.waitUntil(handleMemorySearch(interaction, env));
    return deferredMessage(true);
  }

  if (commandName === "persona") {
    ctx.waitUntil(handlePersonaInteraction(interaction, env));
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
    if (await personaNeedsSeed(env, userId)) {
      await editOriginalInteraction(env.DISCORD_APPLICATION_ID, interaction.token, personaSetupPrompt());
      return;
    }

    const reply = await generateCounselorReply({
      env,
      userId,
      channelId: interaction.channel_id,
      interactionId: interaction.id,
      message,
      useTimeline: false
    });
    await editOriginalInteraction(env.DISCORD_APPLICATION_ID, interaction.token, reply.text);
  } catch (error) {
    console.error(error);
    await editOriginalInteraction(
      env.DISCORD_APPLICATION_ID,
      interaction.token,
      `処理中に失敗しました。\n\`${error instanceof Error ? error.message : String(error)}\``
    );
  }
}

async function generateCounselorReply(input: {
  env: Env;
  userId: string;
  channelId?: string;
  interactionId?: string;
  message: string;
  timeline?: string;
  useTimeline?: boolean;
}): Promise<{ text: string; delayMs?: number }> {
  const timeline = input.useTimeline
    ? await prepareIncomingTimeline({
      env: input.env,
      userId: input.userId,
      channelId: input.channelId,
      message: input.message
    })
    : undefined;
  const memory = await buildMemoryContext(input.env, input.userId, input.message);
  const persona = await buildPersonaContext(input.env, input.userId);
  const now = Date.now();
  const life = await getBotLifeState(input.env, input.userId)
    ?? await getOrCreateBotLifeState(input.env, input.userId, null, now);
  const world = buildWorldContext({
    persona,
    life,
    now,
    timeZone: input.env.MEMORY_TIME_ZONE || "Asia/Tokyo"
  });
  const prompt = buildCounselorPrompt({
    userMessage: input.message,
    memory,
    persona: persona.formatted,
    world,
    timeline: input.timeline ?? timeline?.formatted,
    language: input.env.COUNSELOR_LANGUAGE || "ja",
    nowIso: new Date(now).toISOString()
  });

  const response = await runCodexChat(input.env, {
    prompt,
    model: input.env.CODEX_MODEL || undefined
  });

  const text = response.text.trim() || "うまく言葉にできませんでした。もう一度だけ送ってください。";
  await storeConversationMemory({
    env: input.env,
    userId: input.userId,
    channelId: input.channelId,
    interactionId: input.interactionId,
    userMessage: input.message,
    assistantMessage: text
  });
  if (input.useTimeline) {
    await markAssistantReplied({
      env: input.env,
      userId: input.userId,
      channelId: input.channelId
    });
  }
  return { text, delayMs: timeline?.replyDelayMs };
}

async function generateProactiveMessage(
  env: Env,
  state: Awaited<ReturnType<typeof getDueProactiveStates>>[number],
  now: number
): Promise<string> {
  const memory = await buildMemoryContext(env, state.discord_user_id, "最近の気分、生活、会話の流れ、気軽な雑談");
  const persona = await buildPersonaContext(env, state.discord_user_id);
  const life = await getOrCreateBotLifeState(env, state.discord_user_id, state, now);
  const world = buildWorldContext({
    persona,
    life,
    now,
    timeZone: env.MEMORY_TIME_ZONE || "Asia/Tokyo"
  });
  const prompt = buildProactivePrompt({
    memory,
    persona: persona.formatted,
    world,
    timeline: [
      formatTimelineContext(state, now),
      "",
      "Private timing state:",
      formatLifeContext(life, now)
    ].join("\n"),
    language: env.COUNSELOR_LANGUAGE || "ja",
    nowIso: new Date(now).toISOString()
  });

  const response = await runCodexChat(env, {
    prompt,
    model: env.CODEX_MODEL || undefined
  });

  const text = response.text.trim() || "ふと思い出した。今どんな感じ？";
  await storeAssistantMemory({
    env,
    userId: state.discord_user_id,
    channelId: state.channel_id ?? undefined,
    content: text,
    eventType: "proactive_message",
    now
  });
  await markProactiveSent({ env, state, now });
  return text;
}

async function handleLogin(interaction: DiscordInteraction, env: Env): Promise<void> {
  try {
    const result = await callRunner<Record<string, unknown>>(env, "/auth/start", {});
    const userId = interactionUserId(interaction);
    const profile = userId ? await ensurePersonaProfile(env, userId) : null;
    await editOriginalInteraction(
      env.DISCORD_APPLICATION_ID,
      interaction.token,
      appendPersonaSetup(formatAuthStart(result), profile?.status !== "active")
    );
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
    const [auth, stats, persona, freeze] = await Promise.all([
      callRunner<Record<string, unknown>>(env, "/auth/status"),
      memoryStats(env, userId),
      formatPersonaStatus(env, userId),
      getWorldFreezeState(env, userId)
    ]);

    await editOriginalInteraction(
      env.DISCORD_APPLICATION_ID,
      interaction.token,
      [
        `runner: ${env.RUNNER_BACKEND || "container"}`,
        formatAuthStatus(auth),
        stats,
        persona,
        formatWorldFreezeStatus(freeze)
      ].join("\n\n")
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

async function handleWorldFreezeInteraction(interaction: DiscordInteraction, env: Env): Promise<void> {
  const userId = interactionUserId(interaction);
  if (!userId) return;

  try {
    const mode = getOption<string>(interaction.data?.options, "mode") ?? "";
    await editOriginalInteraction(
      env.DISCORD_APPLICATION_ID,
      interaction.token,
      await handleWorldFreezeCommand(env, userId, mode)
    );
  } catch (error) {
    console.error(error);
    await editOriginalInteraction(
      env.DISCORD_APPLICATION_ID,
      interaction.token,
      `worldfreeze操作に失敗しました。\n\`${error instanceof Error ? error.message : String(error)}\``
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

async function handlePersonaInteraction(interaction: DiscordInteraction, env: Env): Promise<void> {
  const userId = interactionUserId(interaction);
  if (!userId) return;

  try {
    const result = await handlePersonaCommand(env, userId, personaInteractionArgument(interaction));
    await editOriginalInteraction(env.DISCORD_APPLICATION_ID, interaction.token, result.content);
  } catch (error) {
    console.error(error);
    await editOriginalInteraction(
      env.DISCORD_APPLICATION_ID,
      interaction.token,
      `persona操作に失敗しました。\n\`${error instanceof Error ? error.message : String(error)}\``
    );
  }
}

async function handleWorldFreezeCommand(
  env: Env,
  userId: string,
  argument: string
): Promise<string> {
  const mode = parseWorldFreezeMode(argument);
  if (mode === "status") {
    return formatWorldFreezeStatus(await getWorldFreezeState(env, userId));
  }

  const state = await setWorldFrozen({
    env,
    userId,
    frozen: mode === "on",
    reason: mode === "on" ? "manual /worldfreeze" : "manual /worldfreeze off"
  });

  return mode === "on"
    ? [
      "worldfreezeをONにしました。",
      "世界エミュレート、ペルソナ自動拡張、proactive送信、pending自動返信を停止します。",
      "",
      formatWorldFreezeStatus(state)
    ].join("\n")
    : [
      "worldfreezeをOFFにしました。",
      "世界エミュレートと自動送信を再開します。",
      "",
      formatWorldFreezeStatus(state)
    ].join("\n");
}

async function handlePersonaCommand(
  env: Env,
  userId: string,
  argument: string
): Promise<DiscordDmResponse> {
  const trimmed = argument.trim();
  const profile = await getPersonaProfile(env, userId);
  const currentName = currentBotResetName(profile);
  if (!trimmed || trimmed === "status") {
    return {
      content: [
        await formatPersonaStatus(env, userId),
        "",
        profile?.status === "active"
          ? `作り直すなら先に \`/persona reset ${currentName}\` と送ってください。全会話履歴も消えます。`
          : "そのまま `/persona 名前はゆい、21歳...` みたいに送ると初期ペルソナを作れます。"
      ].join("\n")
    };
  }

  const resetMatch = trimmed.match(/^(reset|clear|やり直し|リセット)(?:\s+(.+))?$/i);
  if (resetMatch) {
    const providedName = resetMatch[2]?.trim();
    if (!providedName || !sameResetName(providedName, currentName)) {
      return {
        content: [
          "リセットは全会話履歴と記憶を消すので、確認として今のBot名を一緒に送ってください。",
          `例: \`/persona reset ${currentName}\``
        ].join("\n")
      };
    }

    const deleted = await resetAllUserData(env, userId);
    return {
      content: [
        `ペルソナを作り直すために、このユーザー分のDB状態を初期化しました。conversation ${deleted.conversations}件、memory ${deleted.memoryItems}件、pending ${deleted.pendingMessages}件。`,
        "DiscordのDM履歴も、このあとBot側で消せる範囲を掃除します。",
        "",
        personaSetupPrompt()
      ].join("\n"),
      purgeDiscordHistory: true,
      purgeLimit: 500,
      deleteTriggerMessage: true
    };
  }

  if (!looksLikePersonaSeed(trimmed)) {
    return {
      content: [
        "ペルソナ材料としては少し短いかも。",
        "",
        personaSetupPrompt()
      ].join("\n")
    };
  }

  if (profile?.status === "active") {
    return {
      content: [
        "既存ペルソナがある状態で直接作り直すと会話履歴も全部消えるので、先に名前確認つきでリセットしてください。",
        `例: \`/persona reset ${currentName}\``,
        "",
        "その後に新しいペルソナ材料を送ってください。"
      ].join("\n")
    };
  }

  await resetAllUserData(env, userId);
  const persona = await initializePersonaFromSeed({
    env,
    userId,
    seed: trimmed
  });
  return {
    content: [
      "更新した。",
      "この人格と世界線で続けるね。"
    ].join("\n"),
    botUsername: personaBotUsername(persona.profile),
    deleteTriggerMessage: true
  };
}

function personaInteractionArgument(interaction: DiscordInteraction): string {
  const subcommand = interaction.data?.options?.[0];
  if (!subcommand) return "status";

  if (subcommand.name === "status") return "status";
  if (subcommand.name === "set") {
    return getOption<string>(subcommand.options, "seed")?.trim() ?? "";
  }
  if (subcommand.name === "reset") {
    const name = getOption<string>(subcommand.options, "name")?.trim();
    return `reset ${name ?? ""}`.trim();
  }
  return "status";
}

async function resetAllUserData(
  env: Env,
  userId: string
): Promise<{ conversations: number; memoryItems: number; pendingMessages: number }> {
  const [conversationCount, pending] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM conversations
       WHERE discord_user_id = ?`
    ).bind(userId).first<{ count: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM dm_pending_messages
       WHERE discord_user_id = ?`
    ).bind(userId).first<{ count: number }>()
  ]);
  const memoryItems = await forgetAllMemory(env, userId);

  await env.DB.batch([
    env.DB.prepare(`DELETE FROM dm_pending_messages WHERE discord_user_id = ?`).bind(userId),
    env.DB.prepare(`DELETE FROM conversation_states WHERE discord_user_id = ?`).bind(userId),
    env.DB.prepare(`DELETE FROM bot_life_states WHERE discord_user_id = ?`).bind(userId),
    env.DB.prepare(`DELETE FROM bot_life_events WHERE discord_user_id = ?`).bind(userId),
    env.DB.prepare(`DELETE FROM persona_edges WHERE discord_user_id = ?`).bind(userId),
    env.DB.prepare(`DELETE FROM persona_nodes WHERE discord_user_id = ?`).bind(userId),
    env.DB.prepare(`DELETE FROM persona_profiles WHERE discord_user_id = ?`).bind(userId),
    env.DB.prepare(`DELETE FROM persona_events WHERE discord_user_id = ?`).bind(userId),
    env.DB.prepare(`DELETE FROM memory_events WHERE discord_user_id = ?`).bind(userId)
  ]);

  return {
    conversations: conversationCount?.count ?? 0,
    memoryItems,
    pendingMessages: pending?.count ?? 0
  };
}

function currentBotResetName(profile: Awaited<ReturnType<typeof getPersonaProfile>>): string {
  if (profile?.status === "active") {
    return personaBotUsername(profile) ?? profile.display_name ?? "PsychologicalCounselor";
  }
  return "PsychologicalCounselor";
}

function sameResetName(input: string, expected: string): boolean {
  return normalizeResetName(input) === normalizeResetName(expected);
}

function normalizeResetName(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

function formatAuthStart(value: Record<string, unknown>): string {
  const output = [
    asString(value.output),
    asRecord(value.authProcess)?.output ? asString(asRecord(value.authProcess)?.output) : undefined
  ].filter(Boolean).join("\n");
  const verificationUri = asString(value.verificationUri) || parseVerificationUri(output);
  const userCode = asString(value.userCode) || parseUserCode(output);

  if (value.status === "already_authenticated") {
    return "Codexはすでにログイン済みです。";
  }
  if (value.status === "pending" || value.status === "started") {
    return [
      "Codex device loginを開始しました。",
      verificationUri ? `URL: ${verificationUri}` : undefined,
      userCode ? `code: \`${userCode}\`` : undefined,
      "ブラウザで認証が終わったら `/status` で確認できます。"
    ].filter(Boolean).join("\n");
  }
  return formatObject(value);
}

function appendPersonaSetup(content: string, needsSetup: boolean): string {
  if (!needsSetup) return content;
  return [
    content,
    "",
    personaSetupPrompt()
  ].join("\n");
}

function formatObject(value: unknown): string {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function formatAuthStatus(value: Record<string, unknown>): string {
  const authProcess = asRecord(value.authProcess);
  return formatObject({
    ok: value.ok,
    status: value.status,
    stdout: asString(value.stdout) || undefined,
    stderr: asString(value.stderr) || undefined,
    authProcess: authProcess ? {
      status: authProcess.status,
      startedAt: authProcess.startedAt,
      finishedAt: authProcess.finishedAt,
      error: authProcess.error
    } : undefined
  });
}

function isRunnerAuthorized(request: Request, env: Env): boolean {
  return request.headers.get("authorization") === `Bearer ${env.RUNNER_SHARED_SECRET}`;
}

function parseDmCommand(content: string): { name: string | null; argument: string } {
  const trimmed = content.trim();
  const match = trimmed.match(/^[/!](login|status|memory|forget|persona|worldfreeze)\b\s*(.*)$/i);
  if (!match) return { name: null, argument: trimmed };
  return {
    name: match[1].toLowerCase(),
    argument: match[2].trim()
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? stripAnsi(value).trim() : undefined;
}

function parseVerificationUri(output: string): string | undefined {
  return stripAnsi(output).match(/https:\/\/[^\s]+/)?.[0].replace(/[).,;]+$/, "");
}

function parseUserCode(output: string): string | undefined {
  return stripAnsi(output).match(/\b[A-Z0-9]{4,}-[A-Z0-9-]{4,}\b/)?.[0];
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function randomImmediateDelay(): number {
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return 1_200 + (bytes[0] % 2_800);
}
