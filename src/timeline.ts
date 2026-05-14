import type { ConversationState, DueReply, Env, TimelineContext } from "./types";

const CADENCE = {
  fast: {
    minDelayMs: 2_000,
    maxDelayMs: 18_000,
    minProactiveMs: 90 * 60_000,
    maxProactiveMs: 4 * 60 * 60_000,
    reason: "user wants quick replies"
  },
  normal: {
    minDelayMs: 35_000,
    maxDelayMs: 6 * 60_000,
    minProactiveMs: 4 * 60 * 60_000,
    maxProactiveMs: 10 * 60 * 60_000,
    reason: "default conversational pace"
  },
  slow: {
    minDelayMs: 5 * 60_000,
    maxDelayMs: 30 * 60_000,
    minProactiveMs: 8 * 60 * 60_000,
    maxProactiveMs: 22 * 60 * 60_000,
    reason: "user prefers more space"
  }
} as const;

type TimingMode =
  | "crisis"
  | "distress"
  | "live_thread"
  | "followup"
  | "closing"
  | "busy"
  | "asleep"
  | "ambient";

type PendingMessage = {
  id: string;
  message_id: string;
  content: string;
  created_at: number;
};

type ReplyPlan = {
  delayMs: number;
  scheduledAt: number;
  generation: number;
  timingMode: TimingMode;
  reason: string;
};

export async function ingestIncomingMessage(input: {
  env: Env;
  userId: string;
  channelId: string;
  messageId: string;
  message: string;
  now?: number;
}): Promise<ReplyPlan> {
  const now = input.now ?? Date.now();
  const previous = await getConversationState(input.env, input.userId);

  await input.env.DB.prepare(
    `INSERT OR IGNORE INTO dm_pending_messages
       (id, discord_user_id, channel_id, message_id, content, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(
    crypto.randomUUID(),
    input.userId,
    input.channelId,
    input.messageId,
    input.message,
    now
  ).run();

  const pendingCount = await countPendingMessages(input.env, input.userId, input.channelId);
  const recentTurnCount = await countRecentTurns(input.env, input.userId, now - 20 * 60_000);
  const cadence = chooseCadence(input.message, previous?.reply_cadence ?? "normal");
  const context = classifyTimingContext({
    message: input.message,
    previous,
    pendingCount,
    recentTurnCount,
    now
  });
  const presence = choosePresence(previous, context.mode, now);
  const delayMs = chooseHumanDelay({
    message: input.message,
    cadence: cadence.value,
    mode: context.mode,
    pendingCount,
    recentTurnCount,
    attention: presence.attention,
    energy: presence.energy,
    now
  });
  const profile = CADENCE[cadence.value];
  const scheduledAt = now + delayMs;
  const proactiveAt = now + randomInt(profile.minProactiveMs, profile.maxProactiveMs);
  const activeUntil = chooseActiveUntil(context.mode, now);
  const generation = (previous?.pending_reply_generation ?? 0) + 1;

  await upsertConversationState(input.env, {
    userId: input.userId,
    channelId: input.channelId,
    cadence: cadence.value,
    minDelayMs: profile.minDelayMs,
    maxDelayMs: profile.maxDelayMs,
    minProactiveMs: profile.minProactiveMs,
    maxProactiveMs: profile.maxProactiveMs,
    lastUserMessageAt: now,
    nextProactiveAt: proactiveAt,
    cadenceReason: cadence.reason ?? previous?.cadence_reason ?? profile.reason,
    activeUntil,
    availabilityMode: presence.availability,
    attention: presence.attention,
    energy: presence.energy,
    pendingReplyAfter: scheduledAt,
    pendingReplyGeneration: generation,
    timingReason: context.reason,
    now
  });

  return {
    delayMs,
    scheduledAt,
    generation,
    timingMode: context.mode,
    reason: context.reason
  };
}

export async function getDuePendingReplies(
  env: Env,
  limit: number,
  now = Date.now()
): Promise<DueReply[]> {
  const rows = await env.DB.prepare(
    `SELECT s.discord_user_id AS userId,
            s.channel_id AS channelId,
            s.pending_reply_generation AS generation,
            s.pending_reply_after AS scheduledAt
     FROM conversation_states s
     WHERE s.channel_id IS NOT NULL
       AND s.pending_reply_after IS NOT NULL
       AND s.pending_reply_after <= ?
       AND EXISTS (
         SELECT 1 FROM dm_pending_messages p
         WHERE p.discord_user_id = s.discord_user_id
           AND p.channel_id = s.channel_id
           AND p.responded_at IS NULL
       )
     ORDER BY s.pending_reply_after ASC
     LIMIT ?`
  ).bind(now, Math.max(1, Math.min(limit, 5))).all<DueReply>();

  return rows.results;
}

export async function buildPendingReplyContext(input: {
  env: Env;
  userId: string;
  channelId: string;
  generation?: number;
  force?: boolean;
  now?: number;
}): Promise<{
  ready: boolean;
  skippedReason?: string;
  messages: PendingMessage[];
  combinedMessage: string;
  timeline: string;
  state: ConversationState | null;
}> {
  const now = input.now ?? Date.now();
  const state = await getConversationState(input.env, input.userId);
  if (!state) {
    return emptyPending("no conversation state");
  }
  if (input.generation !== undefined && input.generation < (state.pending_reply_generation ?? 0)) {
    return emptyPending("stale generation");
  }
  if (!input.force && state.pending_reply_after && state.pending_reply_after > now) {
    return emptyPending("not due yet");
  }

  const rows = await input.env.DB.prepare(
    `SELECT id, message_id, content, created_at
     FROM dm_pending_messages
     WHERE discord_user_id = ?
       AND channel_id = ?
       AND responded_at IS NULL
     ORDER BY created_at ASC`
  ).bind(input.userId, input.channelId).all<PendingMessage>();

  const messages = rows.results;
  if (messages.length === 0) return emptyPending("no pending messages");

  return {
    ready: true,
    messages,
    combinedMessage: formatPendingMessages(messages, now),
    timeline: formatTimelineContext(state, now),
    state
  };
}

export async function markPendingReplySent(input: {
  env: Env;
  userId: string;
  channelId: string;
  messageIds: string[];
  now?: number;
}): Promise<void> {
  const now = input.now ?? Date.now();
  const profile = CADENCE.normal;
  const current = await getConversationState(input.env, input.userId);
  const proactiveAt = now + randomInt(
    current?.proactive_interval_min_ms ?? profile.minProactiveMs,
    current?.proactive_interval_max_ms ?? profile.maxProactiveMs
  );

  const statements = [
    input.env.DB.prepare(
      `UPDATE conversation_states
       SET last_assistant_message_at = ?,
           pending_reply_after = NULL,
           next_proactive_at = ?,
           updated_at = ?
       WHERE discord_user_id = ?`
    ).bind(now, proactiveAt, now, input.userId)
  ];

  for (const chunk of chunks(input.messageIds, 100)) {
    const placeholders = chunk.map(() => "?").join(", ");
    statements.push(
      input.env.DB.prepare(
        `UPDATE dm_pending_messages
         SET responded_at = ?
         WHERE discord_user_id = ?
           AND channel_id = ?
           AND id IN (${placeholders})`
      ).bind(now, input.userId, input.channelId, ...chunk)
    );
  }

  await input.env.DB.batch(statements);
}

export async function prepareIncomingTimeline(input: {
  env: Env;
  userId: string;
  channelId?: string;
  message: string;
  now?: number;
}): Promise<TimelineContext> {
  const now = input.now ?? Date.now();
  const previous = await getConversationState(input.env, input.userId);
  const cadence = chooseCadence(input.message, previous?.reply_cadence ?? "normal");
  const profile = CADENCE[cadence.value];
  const delay = chooseHumanDelay({
    message: input.message,
    cadence: cadence.value,
    mode: classifyTimingContext({
      message: input.message,
      previous,
      pendingCount: 1,
      recentTurnCount: 0,
      now
    }).mode,
    pendingCount: 1,
    recentTurnCount: 0,
    attention: previous?.attention_score ?? 0.6,
    energy: previous?.energy_score ?? 0.7,
    now
  });
  const proactiveAt = now + randomInt(profile.minProactiveMs, profile.maxProactiveMs);

  await upsertConversationState(input.env, {
    userId: input.userId,
    channelId: input.channelId,
    cadence: cadence.value,
    minDelayMs: profile.minDelayMs,
    maxDelayMs: profile.maxDelayMs,
    minProactiveMs: profile.minProactiveMs,
    maxProactiveMs: profile.maxProactiveMs,
    lastUserMessageAt: now,
    nextProactiveAt: proactiveAt,
    cadenceReason: cadence.reason ?? previous?.cadence_reason ?? profile.reason,
    activeUntil: chooseActiveUntil("ambient", now),
    availabilityMode: previous?.availability_mode ?? "normal",
    attention: previous?.attention_score ?? 0.6,
    energy: previous?.energy_score ?? 0.7,
    pendingReplyAfter: previous?.pending_reply_after ?? null,
    pendingReplyGeneration: previous?.pending_reply_generation ?? 0,
    timingReason: "legacy direct response",
    now
  });

  const next = await getConversationState(input.env, input.userId);
  return {
    cadence: cadence.value,
    replyDelayMs: delay,
    formatted: formatTimelineContext(next, now, delay)
  };
}

export async function markAssistantReplied(input: {
  env: Env;
  userId: string;
  channelId?: string;
  now?: number;
}): Promise<void> {
  const now = input.now ?? Date.now();
  await input.env.DB.prepare(
    `UPDATE conversation_states
     SET channel_id = COALESCE(?, channel_id),
         last_assistant_message_at = ?,
         updated_at = ?
     WHERE discord_user_id = ?`
  ).bind(input.channelId ?? null, now, now, input.userId).run();
}

export async function getDueProactiveStates(
  env: Env,
  limit: number,
  now = Date.now()
): Promise<ConversationState[]> {
  const rows = await env.DB.prepare(
    `SELECT *
     FROM conversation_states
     WHERE proactive_enabled = 1
       AND channel_id IS NOT NULL
       AND next_proactive_at IS NOT NULL
       AND next_proactive_at <= ?
       AND (pending_reply_after IS NULL OR pending_reply_after > ?)
     ORDER BY next_proactive_at ASC
     LIMIT ?`
  ).bind(now, now, Math.max(1, Math.min(limit, 5))).all<ConversationState>();

  return rows.results;
}

export async function markProactiveSent(input: {
  env: Env;
  state: ConversationState;
  now?: number;
}): Promise<number> {
  const now = input.now ?? Date.now();
  const next = now + randomInt(
    input.state.proactive_interval_min_ms,
    input.state.proactive_interval_max_ms
  );

  await input.env.DB.prepare(
    `UPDATE conversation_states
     SET last_assistant_message_at = ?,
         last_proactive_at = ?,
         next_proactive_at = ?,
         updated_at = ?
     WHERE discord_user_id = ?`
  ).bind(now, now, next, now, input.state.discord_user_id).run();

  return next;
}

export function formatTimelineContext(
  state: ConversationState | null,
  now: number,
  replyDelayMs?: number
): string {
  if (!state) {
    return [
      "- Relationship timeline: first known exchange.",
      replyDelayMs === undefined ? undefined : `- Planned reply delay: about ${formatDuration(replyDelayMs)}.`
    ].filter(Boolean).join("\n");
  }

  return [
    `- Reply cadence preference: ${state.reply_cadence}${state.cadence_reason ? ` (${state.cadence_reason})` : ""}.`,
    state.availability_mode ? `- Simulated availability now: ${state.availability_mode}.` : undefined,
    state.timing_reason ? `- Current timing reason: ${state.timing_reason}.` : undefined,
    state.attention_score === null ? undefined : `- Attention score: ${state.attention_score.toFixed(2)}.`,
    state.energy_score === null ? undefined : `- Energy score: ${state.energy_score.toFixed(2)}.`,
    state.last_user_message_at ? `- Last user message: ${formatAgo(now - state.last_user_message_at)} ago.` : undefined,
    state.last_assistant_message_at ? `- Last assistant message: ${formatAgo(now - state.last_assistant_message_at)} ago.` : undefined,
    state.active_until && state.active_until > now ? `- Conversation feels live for about ${formatDuration(state.active_until - now)} more.` : undefined,
    state.last_proactive_at ? `- Last proactive check-in: ${formatAgo(now - state.last_proactive_at)} ago.` : undefined,
    state.next_proactive_at ? `- Next casual check-in is scheduled around ${new Date(state.next_proactive_at).toISOString()}.` : undefined,
    replyDelayMs === undefined ? undefined : `- Planned reply delay: about ${formatDuration(replyDelayMs)}.`
  ].filter(Boolean).join("\n");
}

export function proactiveDelayMs(): number {
  return randomInt(20_000, 120_000);
}

function classifyTimingContext(input: {
  message: string;
  previous: ConversationState | null;
  pendingCount: number;
  recentTurnCount: number;
  now: number;
}): { mode: TimingMode; reason: string } {
  const text = normalize(input.message);
  const lastAssistantAgo = input.previous?.last_assistant_message_at
    ? input.now - input.previous.last_assistant_message_at
    : Number.POSITIVE_INFINITY;
  const active = Boolean(input.previous?.active_until && input.previous.active_until > input.now);

  if (/(自殺|死にたい|消えたい|殺して|今から死|od|overdose|過量|首.*吊|飛び降り|緊急|助けて)/.test(text)) {
    return { mode: "crisis", reason: "possible immediate danger" };
  }
  if (/(鬱|うつ|つらい|辛い|しんどい|苦しい|泣き|不安|パニック|限界|こわい|怖い)/.test(text)) {
    return { mode: "distress", reason: "distressed topic gets quicker attention" };
  }
  if (input.pendingCount >= 2) {
    return { mode: "followup", reason: "user added messages before the reply" };
  }
  if (active || lastAssistantAgo < 8 * 60_000 || /[?？]$/.test(input.message.trim())) {
    return { mode: "live_thread", reason: "conversation is currently active" };
  }
  if (/(ありがとう|ありがと|了解|りょ|おけ|ok|またね|寝る|ねる|おやすみ|以上|終わり|大丈夫)/.test(text)) {
    return { mode: "closing", reason: "conversation looks like it is winding down" };
  }
  if (input.recentTurnCount >= 8) {
    return { mode: "busy", reason: "many recent turns create simulated social fatigue" };
  }
  if (localHour(input.now) >= 1 && localHour(input.now) <= 7) {
    return { mode: "asleep", reason: "late-night low availability" };
  }
  return { mode: "ambient", reason: "ordinary asynchronous DM timing" };
}

function chooseCadence(
  message: string,
  current: ConversationState["reply_cadence"]
): { value: ConversationState["reply_cadence"]; reason?: string } {
  const text = normalize(message);
  if (/(もっと|はやく|早く|すぐ|即レス|返信.*増や|返事.*増や|いっぱい.*返|寂しい|さみしい|構って|かまって)/.test(text)) {
    return { value: "fast", reason: "user asked for more frequent replies" };
  }
  if (/(ゆっくり|遅く|おそく|あとで|返信.*減ら|静かに|距離|忙しい|通知.*少な)/.test(text)) {
    return { value: "slow", reason: "user asked for more space" };
  }
  if (/(普通|ふつう|いつも通り|通常|戻して)/.test(text)) {
    return { value: "normal", reason: "user reset cadence" };
  }
  return { value: current };
}

function choosePresence(
  previous: ConversationState | null,
  mode: TimingMode,
  now: number
): { availability: string; attention: number; energy: number } {
  const hour = localHour(now);
  const baseEnergy = hour >= 1 && hour <= 7 ? 0.2
    : hour >= 9 && hour <= 17 ? 0.55
      : hour >= 20 || hour <= 0 ? 0.82
        : 0.68;
  const baseAttention = mode === "live_thread" || mode === "followup" ? 0.9
    : mode === "crisis" || mode === "distress" ? 0.95
      : mode === "closing" ? 0.35
        : 0.55;
  const jitter = randomInt(-12, 12) / 100;
  const attention = clamp((previous?.attention_score ?? baseAttention) * 0.35 + baseAttention * 0.65 + jitter);
  const energy = clamp((previous?.energy_score ?? baseEnergy) * 0.45 + baseEnergy * 0.55 + jitter / 2);
  const availability = mode === "asleep" ? "asleep"
    : attention > 0.78 && energy > 0.55 ? "present"
      : attention < 0.4 || energy < 0.35 ? "distracted"
        : "normal";
  return { availability, attention, energy };
}

function chooseHumanDelay(input: {
  message: string;
  cadence: ConversationState["reply_cadence"];
  mode: TimingMode;
  pendingCount: number;
  recentTurnCount: number;
  attention: number;
  energy: number;
  now: number;
}): number {
  const base = delayRange(input.mode, input.cadence);
  let min = base.min;
  let max = base.max;

  if (input.pendingCount >= 2) {
    min = Math.min(min, 2_000);
    max = Math.min(max, 15_000);
  }

  const availabilityMultiplier = 1 + (1 - input.attention) * 1.4 + (1 - input.energy) * 1.1;
  const socialFatigueMultiplier = input.recentTurnCount > 5
    ? 1 + Math.min(1.4, (input.recentTurnCount - 5) * 0.18)
    : 1;
  const cadenceMultiplier = input.cadence === "fast" ? 0.55 : input.cadence === "slow" ? 1.8 : 1;
  const multiplier = (input.mode === "crisis" || input.mode === "distress" || input.mode === "live_thread")
    ? cadenceMultiplier
    : availabilityMultiplier * socialFatigueMultiplier * cadenceMultiplier;

  return Math.round(randomInt(min, max) * multiplier);
}

function delayRange(mode: TimingMode, cadence: ConversationState["reply_cadence"]): { min: number; max: number } {
  if (mode === "crisis") return { min: 400, max: 2_000 };
  if (mode === "distress") return { min: 3_000, max: 18_000 };
  if (mode === "live_thread") return { min: 1_500, max: cadence === "slow" ? 35_000 : 14_000 };
  if (mode === "followup") return { min: 1_000, max: 10_000 };
  if (mode === "closing") return { min: 8 * 60_000, max: 45 * 60_000 };
  if (mode === "busy") return { min: 4 * 60_000, max: 35 * 60_000 };
  if (mode === "asleep") return { min: 25 * 60_000, max: 3 * 60 * 60_000 };
  return { min: CADENCE[cadence].minDelayMs, max: CADENCE[cadence].maxDelayMs };
}

function chooseActiveUntil(mode: TimingMode, now: number): number | null {
  if (mode === "crisis" || mode === "distress") return now + randomInt(20 * 60_000, 60 * 60_000);
  if (mode === "live_thread" || mode === "followup") return now + randomInt(8 * 60_000, 25 * 60_000);
  if (mode === "closing") return now + randomInt(30_000, 3 * 60_000);
  if (mode === "ambient") return now + randomInt(4 * 60_000, 12 * 60_000);
  return null;
}

async function getConversationState(env: Env, userId: string): Promise<ConversationState | null> {
  return env.DB.prepare(
    `SELECT * FROM conversation_states WHERE discord_user_id = ?`
  ).bind(userId).first<ConversationState>();
}

async function countPendingMessages(env: Env, userId: string, channelId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS count
     FROM dm_pending_messages
     WHERE discord_user_id = ?
       AND channel_id = ?
       AND responded_at IS NULL`
  ).bind(userId, channelId).first<{ count: number }>();
  return row?.count ?? 0;
}

async function countRecentTurns(env: Env, userId: string, since: number): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS count
     FROM conversations
     WHERE discord_user_id = ?
       AND created_at >= ?`
  ).bind(userId, since).first<{ count: number }>();
  return row?.count ?? 0;
}

async function upsertConversationState(env: Env, input: {
  userId: string;
  channelId?: string;
  cadence: ConversationState["reply_cadence"];
  minDelayMs: number;
  maxDelayMs: number;
  minProactiveMs: number;
  maxProactiveMs: number;
  lastUserMessageAt: number;
  nextProactiveAt: number;
  cadenceReason: string;
  activeUntil: number | null;
  availabilityMode: string;
  attention: number;
  energy: number;
  pendingReplyAfter: number | null;
  pendingReplyGeneration: number;
  timingReason: string;
  now: number;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO conversation_states (
       discord_user_id,
       channel_id,
       reply_cadence,
       reply_delay_min_ms,
       reply_delay_max_ms,
       proactive_enabled,
       proactive_interval_min_ms,
       proactive_interval_max_ms,
       last_user_message_at,
       next_proactive_at,
       cadence_reason,
       active_until,
       availability_mode,
       attention_score,
       energy_score,
       pending_reply_after,
       pending_reply_generation,
       timing_reason,
       updated_at
     )
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(discord_user_id) DO UPDATE SET
       channel_id = COALESCE(excluded.channel_id, conversation_states.channel_id),
       reply_cadence = excluded.reply_cadence,
       reply_delay_min_ms = excluded.reply_delay_min_ms,
       reply_delay_max_ms = excluded.reply_delay_max_ms,
       proactive_interval_min_ms = excluded.proactive_interval_min_ms,
       proactive_interval_max_ms = excluded.proactive_interval_max_ms,
       last_user_message_at = excluded.last_user_message_at,
       next_proactive_at = excluded.next_proactive_at,
       cadence_reason = excluded.cadence_reason,
       active_until = excluded.active_until,
       availability_mode = excluded.availability_mode,
       attention_score = excluded.attention_score,
       energy_score = excluded.energy_score,
       pending_reply_after = excluded.pending_reply_after,
       pending_reply_generation = excluded.pending_reply_generation,
       timing_reason = excluded.timing_reason,
       updated_at = excluded.updated_at`
  ).bind(
    input.userId,
    input.channelId ?? null,
    input.cadence,
    input.minDelayMs,
    input.maxDelayMs,
    input.minProactiveMs,
    input.maxProactiveMs,
    input.lastUserMessageAt,
    input.nextProactiveAt,
    input.cadenceReason,
    input.activeUntil,
    input.availabilityMode,
    input.attention,
    input.energy,
    input.pendingReplyAfter,
    input.pendingReplyGeneration,
    input.timingReason,
    input.now
  ).run();
}

function emptyPending(reason: string): {
  ready: false;
  skippedReason: string;
  messages: [];
  combinedMessage: "";
  timeline: "";
  state: null;
} {
  return {
    ready: false,
    skippedReason: reason,
    messages: [],
    combinedMessage: "",
    timeline: "",
    state: null
  };
}

function formatPendingMessages(messages: PendingMessage[], now: number): string {
  if (messages.length === 1) return messages[0].content;
  return [
    `The user sent ${messages.length} messages before you replied. Treat them as one current turn:`,
    ...messages.map((message, index) =>
      `${index + 1}. (${formatAgo(now - message.created_at)} ago) ${message.content}`
    )
  ].join("\n");
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, "");
}

function randomInt(min: number, max: number): number {
  const low = Math.ceil(Math.min(min, max));
  const high = Math.floor(Math.max(min, max));
  const range = high - low + 1;
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return low + (bytes[0] % range);
}

function localHour(now: number): number {
  return Number(new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    hour: "numeric",
    hour12: false
  }).format(new Date(now)));
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function formatAgo(ms: number): string {
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))}s`;
  if (ms < 60 * 60_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 48 * 60 * 60_000) return `${Math.round(ms / (60 * 60_000))}h`;
  return `${Math.round(ms / (24 * 60 * 60_000))}d`;
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)} seconds`;
  return `${Math.round(ms / 60_000)} minutes`;
}
