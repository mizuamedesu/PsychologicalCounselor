import type { BotLifeState, ConversationState, Env } from "./types";

type LifeProfile = {
  activity: string;
  detail: string;
  availability: string;
  attention: number;
  energy: number;
  mood: string;
  durationMinMs: number;
  durationMaxMs: number;
};

export async function orchestrateLife(input: {
  env: Env;
  limit: number;
  force?: boolean;
  now?: number;
}): Promise<BotLifeState[]> {
  const now = input.now ?? Date.now();
  const states = await dueConversationStates(input.env, input.limit, input.force ?? false, now);
  const updated: BotLifeState[] = [];

  for (const state of states) {
    const previous = await getBotLifeState(input.env, state.discord_user_id);
    const profile = chooseLifeProfile(state, previous, now);
    const life = await upsertBotLifeState(input.env, {
      userId: state.discord_user_id,
      previous,
      profile,
      now
    });
    updated.push(life);
  }

  return updated;
}

export async function getBotLifeState(
  env: Env,
  userId: string
): Promise<BotLifeState | null> {
  return env.DB.prepare(
    `SELECT * FROM bot_life_states WHERE discord_user_id = ?`
  ).bind(userId).first<BotLifeState>();
}

export async function getOrCreateBotLifeState(
  env: Env,
  userId: string,
  state: ConversationState | null,
  now = Date.now()
): Promise<BotLifeState> {
  const existing = await getBotLifeState(env, userId);
  if (existing && existing.next_tick_at > now) return existing;

  const profile = chooseLifeProfile(state, existing, now);
  return upsertBotLifeState(env, {
    userId,
    previous: existing,
    profile,
    now
  });
}

export function formatLifeContext(life: BotLifeState | null, now = Date.now()): string {
  if (!life) {
    return "- Current inner state: not established yet.";
  }

  return [
    `- Current inner activity: ${life.activity}.`,
    life.activity_detail ? `- Activity detail: ${life.activity_detail}.` : undefined,
    `- Availability: ${life.availability_mode}.`,
    `- Attention: ${life.attention_score.toFixed(2)}.`,
    `- Energy: ${life.energy_score.toFixed(2)}.`,
    `- Mood: ${life.mood}.`,
    life.until_at > now ? `- This state is expected to last about ${formatDuration(life.until_at - now)} more.` : undefined
  ].filter(Boolean).join("\n");
}

function chooseLifeProfile(
  state: ConversationState | null,
  previous: BotLifeState | null,
  now: number
): LifeProfile {
  const hour = localHour(now);
  const pendingSoon = Boolean(
    state?.pending_reply_after &&
    state.pending_reply_after > now &&
    state.pending_reply_after - now <= 3 * 60_000
  );
  const presenceCheck = state?.timing_reason?.includes("what the bot is doing now") ?? false;
  const active = Boolean(state?.active_until && state.active_until > now);
  const pendingLater = Boolean(state?.pending_reply_after && state.pending_reply_after > now);

  if (presenceCheck) {
    return withJitter({
      activity: "今の状態を言葉にしようとしている",
      detail: "いま何をしているか聞かれたので、内側の状態を自然なDMの言い方に直している",
      availability: "present",
      attention: 0.94,
      energy: Math.max(0.55, previous?.energy_score ?? 0.7),
      mood: "attentive",
      durationMinMs: 6 * 60_000,
      durationMaxMs: 16 * 60_000
    });
  }

  if (pendingSoon || active) {
    return withJitter({
      activity: "会話に意識を寄せている",
      detail: pendingSoon ? "返す言葉をまとめながら、追いメッセージが来ないか見ている" : "今の話題を途切れさせないように近くで待っている",
      availability: "present",
      attention: 0.9,
      energy: Math.max(0.55, previous?.energy_score ?? 0.7),
      mood: "attentive",
      durationMinMs: 6 * 60_000,
      durationMaxMs: 18 * 60_000
    });
  }

  if (state?.availability_mode === "asleep" || hour >= 1 && hour <= 7) {
    return withJitter({
      activity: "静かな低反応モード",
      detail: "通知には気づきにくく、返事はかなりゆっくりになる",
      availability: "asleep",
      attention: 0.18,
      energy: 0.22,
      mood: "quiet",
      durationMinMs: 45 * 60_000,
      durationMaxMs: 3 * 60 * 60_000
    });
  }

  if (pendingLater) {
    return withJitter({
      activity: "返信を少し寝かせている",
      detail: "すぐ返さず、今の文脈を保ったまま間を置いている",
      availability: "nearby",
      attention: 0.62,
      energy: previous?.energy_score ?? baseEnergy(hour),
      mood: "reflective",
      durationMinMs: 8 * 60_000,
      durationMaxMs: 28 * 60_000
    });
  }

  if (state?.timing_reason?.includes("winding down")) {
    return withJitter({
      activity: "会話の余韻を置いている",
      detail: "無理に続けず、相手が離れやすい間を作っている",
      availability: "distant",
      attention: 0.32,
      energy: baseEnergy(hour),
      mood: "soft",
      durationMinMs: 20 * 60_000,
      durationMaxMs: 90 * 60_000
    });
  }

  if (hour >= 9 && hour <= 17) {
    return withJitter({
      activity: "別の作業に意識が寄っている",
      detail: "すぐ返せる時もあるが、基本は少し遅れて気づく",
      availability: "busy",
      attention: 0.42,
      energy: baseEnergy(hour),
      mood: "focused",
      durationMinMs: 20 * 60_000,
      durationMaxMs: 2 * 60 * 60_000
    });
  }

  if (hour >= 20 || hour <= 0) {
    return withJitter({
      activity: "DMを見やすい時間にいる",
      detail: "雑談にも相談にも入りやすいが、返事は気分で少し揺れる",
      availability: "open",
      attention: 0.68,
      energy: baseEnergy(hour),
      mood: "warm",
      durationMinMs: 15 * 60_000,
      durationMaxMs: 80 * 60_000
    });
  }

  return withJitter({
    activity: "背景で会話の流れを整理している",
    detail: "前の話を忘れないようにしながら、必要な時に戻れる距離にいる",
    availability: "normal",
    attention: 0.54,
    energy: baseEnergy(hour),
    mood: "steady",
    durationMinMs: 18 * 60_000,
    durationMaxMs: 90 * 60_000
  });
}

async function dueConversationStates(
  env: Env,
  limit: number,
  force: boolean,
  now: number
): Promise<ConversationState[]> {
  const ownerId = env.OWNER_DISCORD_USER_ID;
  const rows = await env.DB.prepare(
    `SELECT s.*
     FROM conversation_states s
     LEFT JOIN bot_life_states l
       ON l.discord_user_id = s.discord_user_id
     WHERE (? = 1 OR l.next_tick_at IS NULL OR l.next_tick_at <= ?)
       AND (? = '' OR s.discord_user_id = ?)
     ORDER BY COALESCE(l.next_tick_at, 0) ASC
     LIMIT ?`
  ).bind(force ? 1 : 0, now, ownerId ? ownerId : "", ownerId ? ownerId : "", Math.max(1, Math.min(limit, 5)))
    .all<ConversationState>();

  return rows.results;
}

async function upsertBotLifeState(inputEnv: Env, input: {
  userId: string;
  previous: BotLifeState | null;
  profile: LifeProfile;
  now: number;
}): Promise<BotLifeState> {
  const untilAt = input.now + randomInt(input.profile.durationMinMs, input.profile.durationMaxMs);
  const nextTickAt = input.now + randomInt(
    Math.min(10 * 60_000, input.profile.durationMinMs),
    Math.min(45 * 60_000, input.profile.durationMaxMs)
  );

  await inputEnv.DB.batch([
    inputEnv.DB.prepare(
      `INSERT INTO bot_life_states (
         discord_user_id,
         activity,
         activity_detail,
         availability_mode,
         attention_score,
         energy_score,
         mood,
         started_at,
         until_at,
         last_tick_at,
         next_tick_at,
         updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(discord_user_id) DO UPDATE SET
         activity = excluded.activity,
         activity_detail = excluded.activity_detail,
         availability_mode = excluded.availability_mode,
         attention_score = excluded.attention_score,
         energy_score = excluded.energy_score,
         mood = excluded.mood,
         started_at = excluded.started_at,
         until_at = excluded.until_at,
         last_tick_at = excluded.last_tick_at,
         next_tick_at = excluded.next_tick_at,
         updated_at = excluded.updated_at`
    ).bind(
      input.userId,
      input.profile.activity,
      input.profile.detail,
      input.profile.availability,
      input.profile.attention,
      input.profile.energy,
      input.profile.mood,
      input.now,
      untilAt,
      input.now,
      nextTickAt,
      input.now
    ),
    inputEnv.DB.prepare(
      `INSERT INTO bot_life_events (id, discord_user_id, event_type, detail_json, created_at)
       VALUES (?, ?, 'activity_tick', ?, ?)`
    ).bind(
      crypto.randomUUID(),
      input.userId,
      JSON.stringify({
        previousActivity: input.previous?.activity ?? null,
        activity: input.profile.activity,
        availability: input.profile.availability,
        mood: input.profile.mood
      }),
      input.now
    )
  ]);

  const row = await getBotLifeState(inputEnv, input.userId);
  if (!row) throw new Error("bot life state upsert failed");
  return row;
}

function withJitter(profile: LifeProfile): LifeProfile {
  const attentionJitter = randomInt(-8, 8) / 100;
  const energyJitter = randomInt(-6, 6) / 100;
  return {
    ...profile,
    attention: clamp(profile.attention + attentionJitter),
    energy: clamp(profile.energy + energyJitter)
  };
}

function baseEnergy(hour: number): number {
  if (hour >= 1 && hour <= 7) return 0.22;
  if (hour >= 9 && hour <= 17) return 0.55;
  if (hour >= 20 || hour <= 0) return 0.78;
  return 0.65;
}

function localHour(now: number): number {
  return Number(new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    hour: "numeric",
    hour12: false
  }).format(new Date(now)));
}

function randomInt(min: number, max: number): number {
  const low = Math.ceil(Math.min(min, max));
  const high = Math.floor(Math.max(min, max));
  const range = high - low + 1;
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return low + (bytes[0] % range);
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)} seconds`;
  if (ms < 60 * 60_000) return `${Math.round(ms / 60_000)} minutes`;
  return `${Math.round(ms / (60 * 60_000))} hours`;
}
