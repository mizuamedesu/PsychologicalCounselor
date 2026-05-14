import type { CodexRunnerContainer } from "./index";

export interface Env {
  DISCORD_APPLICATION_ID: string;
  DISCORD_PUBLIC_KEY: string;
  OWNER_DISCORD_USER_ID: string;
  OWNER_DISCORD_USERNAME?: string;
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

export interface DiscordDmRequest {
  userId: string;
  username?: string;
  globalName?: string | null;
  channelId?: string;
  messageId?: string;
  content: string;
}

export interface DiscordDmResponse {
  content: string;
  delayMs?: number;
  botUsername?: string;
  purgeDiscordHistory?: boolean;
  purgeLimit?: number;
  deleteTriggerMessage?: boolean;
}

export interface DmIngestResponse {
  accepted: boolean;
  delayMs: number;
  scheduledAt: number;
  generation: number;
  timingMode: string;
  content?: string;
  immediate?: boolean;
  botUsername?: string;
  deleteTriggerMessage?: boolean;
}

export interface DmRespondRequest {
  userId: string;
  channelId: string;
  generation?: number;
  force?: boolean;
}

export interface DmRespondResponse {
  content?: string;
  skipped?: boolean;
  reason?: string;
}

export interface DueReply {
  userId: string;
  channelId: string;
  generation: number;
  scheduledAt: number;
}

export interface DueRepliesResponse {
  replies: DueReply[];
}

export interface ProactiveRequest {
  limit?: number;
}

export interface OrchestrateRequest {
  limit?: number;
  force?: boolean;
}

export interface OrchestrateResponse {
  states: BotLifeState[];
  personaExpansions?: PersonaExpansion[];
  botUsername?: string;
}

export interface ProactiveMessage {
  userId: string;
  channelId: string;
  content: string;
  delayMs?: number;
}

export interface ProactiveResponse {
  messages: ProactiveMessage[];
}

export interface ConversationState {
  discord_user_id: string;
  channel_id: string | null;
  reply_cadence: "fast" | "normal" | "slow";
  reply_delay_min_ms: number;
  reply_delay_max_ms: number;
  proactive_enabled: number;
  proactive_interval_min_ms: number;
  proactive_interval_max_ms: number;
  last_user_message_at: number | null;
  last_assistant_message_at: number | null;
  next_proactive_at: number | null;
  last_proactive_at: number | null;
  cadence_reason: string | null;
  active_until: number | null;
  availability_mode: string | null;
  attention_score: number | null;
  energy_score: number | null;
  pending_reply_after: number | null;
  pending_reply_generation: number | null;
  timing_reason: string | null;
  updated_at: number;
}

export interface TimelineContext {
  formatted: string;
  cadence: ConversationState["reply_cadence"];
  replyDelayMs: number;
}

export interface BotLifeState {
  discord_user_id: string;
  activity: string;
  activity_detail: string;
  availability_mode: string;
  attention_score: number;
  energy_score: number;
  mood: string;
  started_at: number;
  until_at: number;
  last_tick_at: number;
  next_tick_at: number;
  updated_at: number;
}

export interface PersonaProfile {
  discord_user_id: string;
  status: "needs_seed" | "active";
  display_name: string | null;
  seed_text: string | null;
  summary: string | null;
  style_json: string;
  created_at: number;
  updated_at: number;
  last_expanded_at: number | null;
  next_expand_at: number | null;
}

export interface PersonaNode {
  id: string;
  discord_user_id: string;
  node_type: string;
  label: string;
  content: string;
  confidence: number;
  created_at: number;
  updated_at: number;
  metadata_json: string;
}

export interface PersonaEdge {
  id: string;
  discord_user_id: string;
  source_id: string;
  target_id: string;
  edge_type: string;
  weight: number;
  created_at: number;
  metadata_json: string;
}

export interface PersonaContext {
  profile: PersonaProfile | null;
  nodes: PersonaNode[];
  edges: PersonaEdge[];
  formatted: string;
}

export interface PersonaExpansion {
  userId: string;
  expanded: boolean;
  nodeId?: string;
  nextExpandAt?: number;
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
