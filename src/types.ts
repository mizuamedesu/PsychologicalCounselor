import type { CodexRunnerContainer } from "./index";

export interface Env {
  DISCORD_APPLICATION_ID: string;
  DISCORD_PUBLIC_KEY: string;
  OWNER_DISCORD_USER_ID: string;
  COUNSELOR_LANGUAGE: string;
  MEMORY_TIME_ZONE?: string;
  EMBEDDING_MODEL: string;
  MEMORY_MAX_ITEMS: string;
  MEMORY_VECTOR_TOP_K: string;
  MEMORY_TEXT_TOP_K: string;
  MEMORY_RECENT_TOP_K: string;
  CODEX_MODEL?: string;
  RUNNER_BACKEND?: "container" | "http";
  RUNNER_HTTP_BASE_URL?: string;
  RUNNER_SHARED_SECRET: string;
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  R2_ACCOUNT_ID?: string;
  R2_BUCKET_NAME?: string;
  R2_STATE_PREFIX?: string;
  DB: D1Database;
  AI: Ai;
  MEMORY_INDEX: VectorizeIndex;
  CODEX_RUNNER?: DurableObjectNamespace<CodexRunnerContainer>;
}

export interface DiscordInteraction {
  id: string;
  token: string;
  type: number;
  data?: {
    name: string;
    options?: DiscordOption[];
  };
  channel_id?: string;
  user?: DiscordUser;
  member?: {
    user?: DiscordUser;
  };
}

export interface DiscordUser {
  id: string;
  username?: string;
}

export interface DiscordOption {
  name: string;
  type: number;
  value?: string | number | boolean;
  options?: DiscordOption[];
}

export interface MemoryItem {
  id: string;
  conversation_id: string | null;
  discord_user_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  created_at: number;
  created_date: string;
  date_path: string;
  importance: number;
  metadata_json: string;
  score?: number;
  source?: "vector" | "text" | "recent";
}

export interface MemoryContext {
  items: MemoryItem[];
  formatted: string;
}

export interface RunnerChatRequest {
  prompt: string;
  model?: string;
}

export interface RunnerChatResponse {
  text: string;
  usage?: unknown;
  threadId?: string | null;
}
