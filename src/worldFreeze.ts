import type { Env, WorldFreezeState } from "./types";

export type WorldFreezeMode = "on" | "off" | "status";

export async function getWorldFreezeState(
  env: Env,
  userId: string
): Promise<WorldFreezeState | null> {
  return env.DB.prepare(
    `SELECT * FROM world_freezes WHERE discord_user_id = ?`
  ).bind(userId).first<WorldFreezeState>();
}

export async function isWorldFrozen(env: Env, userId: string): Promise<boolean> {
  const state = await getWorldFreezeState(env, userId);
  return state?.frozen === 1;
}

export async function setWorldFrozen(input: {
  env: Env;
  userId: string;
  frozen: boolean;
  reason?: string;
  now?: number;
}): Promise<WorldFreezeState> {
  const now = input.now ?? Date.now();
  await input.env.DB.prepare(
    `INSERT INTO world_freezes (
       discord_user_id,
       frozen,
       reason,
       created_at,
       updated_at
     )
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(discord_user_id) DO UPDATE SET
       frozen = excluded.frozen,
       reason = excluded.reason,
       updated_at = excluded.updated_at`
  ).bind(
    input.userId,
    input.frozen ? 1 : 0,
    input.reason ?? null,
    now,
    now
  ).run();

  const state = await getWorldFreezeState(input.env, input.userId);
  if (!state) throw new Error("world freeze state upsert failed");
  return state;
}

export function parseWorldFreezeMode(argument: string): WorldFreezeMode {
  const value = argument.trim().toLowerCase();
  if (!value || /^(on|freeze|start|true|1|止める|停止|凍結|フリーズ)$/.test(value)) return "on";
  if (/^(off|resume|unfreeze|false|0|解除|再開|戻す)$/.test(value)) return "off";
  return "status";
}

export function formatWorldFreezeStatus(state: WorldFreezeState | null): string {
  if (state?.frozen === 1) {
    return [
      "worldfreeze: ON",
      "世界エミュレート、ペルソナ自動拡張、proactive送信、pending自動返信を停止中。",
      state.reason ? `reason: ${state.reason}` : undefined,
      `updated: ${new Date(state.updated_at).toISOString()}`,
      "解除: `/worldfreeze off`"
    ].filter(Boolean).join("\n");
  }

  return [
    "worldfreeze: OFF",
    "世界エミュレートと自動送信は有効です。",
    "停止: `/worldfreeze`"
  ].join("\n");
}
