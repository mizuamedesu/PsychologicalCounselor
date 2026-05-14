import type { ConversationState, Env, TimelineContext } from "./types";

const CADENCE = {
  fast: {
    minDelayMs: 3_000,
    maxDelayMs: 18_000,
    minProactiveMs: 90 * 60_000,
    maxProactiveMs: 4 * 60 * 60_000,
    reason: "user wants quick replies"
  },
  normal: {
    minDelayMs: 25_000,
    maxDelayMs: 160_000,
    minProactiveMs: 4 * 60 * 60_000,
    maxProactiveMs: 10 * 60 * 60_000,
    reason: "default conversational pace"
  },
  slow: {
    minDelayMs: 2 * 60_000,
    maxDelayMs: 8 * 60_000,
    minProactiveMs: 8 * 60 * 60_000,
    maxProactiveMs: 22 * 60 * 60_000,
    reason: "user prefers more space"
  }
} as const;

const DISTRESS_DELAY = { min: 4_000, max: 20_000 };
const CRISIS_DELAY = { min: 500, max: 3_000 };

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
  const delay = chooseDelay(input.message, cadence.value);
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
    cadenceReason: cadence.reason ?? profile.reason,
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
     ORDER BY next_proactive_at ASC
     LIMIT ?`
  ).bind(now, Math.max(1, Math.min(limit, 5))).all<ConversationState>();

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
    `- Reply cadence: ${state.reply_cadence}${state.cadence_reason ? ` (${state.cadence_reason})` : ""}.`,
    state.last_user_message_at ? `- Last user message: ${formatAgo(now - state.last_user_message_at)} ago.` : undefined,
    state.last_assistant_message_at ? `- Last assistant message: ${formatAgo(now - state.last_assistant_message_at)} ago.` : undefined,
    state.last_proactive_at ? `- Last proactive check-in: ${formatAgo(now - state.last_proactive_at)} ago.` : undefined,
    state.next_proactive_at ? `- Next casual check-in is scheduled around ${new Date(state.next_proactive_at).toISOString()}.` : undefined,
    replyDelayMs === undefined ? undefined : `- Planned reply delay: about ${formatDuration(replyDelayMs)}.`
  ].filter(Boolean).join("\n");
}

export function proactiveDelayMs(): number {
  return randomInt(20_000, 120_000);
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

function chooseDelay(message: string, cadence: ConversationState["reply_cadence"]): number {
  const text = normalize(message);
  if (/(自殺|死にたい|消えたい|殺して|今から死|od| overdose|過量|首.*吊|飛び降り|緊急|助けて)/.test(text)) {
    return randomInt(CRISIS_DELAY.min, CRISIS_DELAY.max);
  }
  if (/(鬱|うつ|つらい|辛い|しんどい|苦しい|泣き|不安|パニック|限界|こわい|怖い)/.test(text)) {
    return randomInt(DISTRESS_DELAY.min, DISTRESS_DELAY.max);
  }
  const profile = CADENCE[cadence];
  return randomInt(profile.minDelayMs, profile.maxDelayMs);
}

async function getConversationState(env: Env, userId: string): Promise<ConversationState | null> {
  return env.DB.prepare(
    `SELECT * FROM conversation_states WHERE discord_user_id = ?`
  ).bind(userId).first<ConversationState>();
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
       updated_at
     )
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
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
    input.now
  ).run();
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
