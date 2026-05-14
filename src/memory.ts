import type { Env, MemoryContext, MemoryItem } from "./types";

interface EmbeddingResponse {
  data?: number[][];
  shape?: number[];
  result?: {
    data?: number[][];
  };
}

export async function buildMemoryContext(
  env: Env,
  userId: string,
  query: string
): Promise<MemoryContext> {
  const [vectorItems, textItems, recentItems] = await Promise.all([
    searchVectorMemory(env, userId, query),
    searchTextMemory(env, userId, query),
    getRecentMemory(env, userId)
  ]);

  const items = dedupeMemory([...vectorItems, ...textItems, ...recentItems]).slice(0, 18);
  return {
    items,
    formatted: formatMemoryItems(items)
  };
}

export async function storeConversationMemory(input: {
  env: Env;
  userId: string;
  channelId?: string;
  interactionId?: string;
  userMessage: string;
  assistantMessage: string;
  now?: number;
}): Promise<void> {
  const now = input.now ?? Date.now();
  const date = dateParts(now, input.env.MEMORY_TIME_ZONE);
  const conversationId = crypto.randomUUID();
  const userMemoryId = makeMemoryId(input.userId);
  const assistantMemoryId = makeMemoryId(input.userId);

  await input.env.DB.batch([
    input.env.DB.prepare(
      `INSERT INTO conversations
        (id, discord_user_id, channel_id, interaction_id, user_message, assistant_message, created_at, created_date, date_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      conversationId,
      input.userId,
      input.channelId ?? null,
      input.interactionId ?? null,
      input.userMessage,
      input.assistantMessage,
      now,
      date.createdDate,
      date.datePath
    ),
    input.env.DB.prepare(
      `INSERT INTO memory_items
        (id, conversation_id, discord_user_id, role, content, created_at, created_date, date_path, importance, metadata_json)
       VALUES (?, ?, ?, 'user', ?, ?, ?, ?, 1, ?)`
    ).bind(
      userMemoryId,
      conversationId,
      input.userId,
      input.userMessage,
      now,
      date.createdDate,
      date.datePath,
      JSON.stringify({ channelId: input.channelId ?? null })
    ),
    input.env.DB.prepare(
      `INSERT INTO memory_items
        (id, conversation_id, discord_user_id, role, content, created_at, created_date, date_path, importance, metadata_json)
       VALUES (?, ?, ?, 'assistant', ?, ?, ?, ?, 1, ?)`
    ).bind(
      assistantMemoryId,
      conversationId,
      input.userId,
      input.assistantMessage,
      now + 1,
      date.createdDate,
      date.datePath,
      JSON.stringify({ channelId: input.channelId ?? null })
    )
  ]);

  await upsertMemoryVectors(input.env, input.userId, [
    {
      id: userMemoryId,
      text: input.userMessage,
      role: "user",
      createdAt: now,
      datePath: date.datePath
    },
    {
      id: assistantMemoryId,
      text: input.assistantMessage,
      role: "assistant",
      createdAt: now + 1,
      datePath: date.datePath
    }
  ]);

  await purgeOldMemory(input.env, input.userId);
}

export async function storeAssistantMemory(input: {
  env: Env;
  userId: string;
  channelId?: string;
  content: string;
  eventType: string;
  now?: number;
}): Promise<void> {
  const now = input.now ?? Date.now();
  const date = dateParts(now, input.env.MEMORY_TIME_ZONE);
  const memoryId = makeMemoryId(input.userId);

  await input.env.DB.batch([
    input.env.DB.prepare(
      `INSERT INTO memory_items
        (id, conversation_id, discord_user_id, role, content, created_at, created_date, date_path, importance, metadata_json)
       VALUES (?, NULL, ?, 'assistant', ?, ?, ?, ?, 1, ?)`
    ).bind(
      memoryId,
      input.userId,
      input.content,
      now,
      date.createdDate,
      date.datePath,
      JSON.stringify({ channelId: input.channelId ?? null, eventType: input.eventType })
    ),
    input.env.DB.prepare(
      `INSERT INTO memory_events (id, discord_user_id, event_type, detail_json, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(
      crypto.randomUUID(),
      input.userId,
      input.eventType,
      JSON.stringify({ channelId: input.channelId ?? null, memoryId }),
      now
    )
  ]);

  await upsertMemoryVectors(input.env, input.userId, [{
    id: memoryId,
    text: input.content,
    role: "assistant",
    createdAt: now,
    datePath: date.datePath
  }]);

  await purgeOldMemory(input.env, input.userId);
}

export async function memoryStats(env: Env, userId: string): Promise<string> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS count, MIN(created_at) AS oldest, MAX(created_at) AS newest
     FROM memory_items
     WHERE discord_user_id = ?`
  ).bind(userId).first<{ count: number; oldest: number | null; newest: number | null }>();

  if (!row || row.count === 0) return "memory: 0 items";

  return [
    `memory: ${row.count} items`,
    `oldest: ${new Date(row.oldest ?? 0).toISOString()}`,
    `newest: ${new Date(row.newest ?? 0).toISOString()}`
  ].join("\n");
}

export async function forgetAllMemory(env: Env, userId: string): Promise<number> {
  const rows = await env.DB.prepare(
    `SELECT id FROM memory_items WHERE discord_user_id = ?`
  ).bind(userId).all<{ id: string }>();
  const ids = rows.results.map((row) => row.id);

  await deleteVectors(env, ids);
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM conversations WHERE discord_user_id = ?`).bind(userId),
    env.DB.prepare(`DELETE FROM memory_items WHERE discord_user_id = ?`).bind(userId),
    env.DB.prepare(
      `INSERT INTO memory_events (id, discord_user_id, event_type, detail_json, created_at)
       VALUES (?, ?, 'forget_all', ?, ?)`
    ).bind(crypto.randomUUID(), userId, JSON.stringify({ deleted: ids.length }), Date.now())
  ]);

  return ids.length;
}

export async function searchMemoryForDisplay(
  env: Env,
  userId: string,
  query: string
): Promise<string> {
  const context = await buildMemoryContext(env, userId, query);
  return context.formatted || "該当する記憶は見つかりませんでした。";
}

async function searchVectorMemory(
  env: Env,
  userId: string,
  query: string
): Promise<MemoryItem[]> {
  const topK = numberFromEnv(env.MEMORY_VECTOR_TOP_K, 8);

  try {
    const vector = (await embedTexts(env, [query]))[0];
    if (!vector) return [];

    const matches = await env.MEMORY_INDEX.query(vector, {
      topK,
      namespace: namespaceForUser(userId),
      returnMetadata: "all"
    });

    const ids = matches.matches.map((match) => match.id);
    const items = await getMemoryItemsByIds(env, ids);
    const scoreById = new Map(matches.matches.map((match) => [match.id, match.score]));
    return items.map((item) => ({
      ...item,
      score: scoreById.get(item.id),
      source: "vector"
    }));
  } catch (error) {
    console.warn("Vector memory search failed", error);
    return [];
  }
}

async function searchTextMemory(
  env: Env,
  userId: string,
  query: string
): Promise<MemoryItem[]> {
  const terms = extractSearchTerms(query).slice(0, 5);
  if (terms.length === 0) return [];

  const topK = numberFromEnv(env.MEMORY_TEXT_TOP_K, 6);
  const where = terms.map(() => "content LIKE ? ESCAPE '\\'").join(" OR ");
  const params = terms.map((term) => `%${escapeLike(term)}%`);
  const rows = await env.DB.prepare(
    `SELECT *
     FROM memory_items
     WHERE discord_user_id = ? AND (${where})
     ORDER BY created_at DESC
     LIMIT ?`
  ).bind(userId, ...params, topK).all<MemoryItem>();

  return rows.results.map((item) => ({ ...item, source: "text" }));
}

async function getRecentMemory(env: Env, userId: string): Promise<MemoryItem[]> {
  const topK = numberFromEnv(env.MEMORY_RECENT_TOP_K, 8);
  const rows = await env.DB.prepare(
    `SELECT *
     FROM memory_items
     WHERE discord_user_id = ?
     ORDER BY created_at DESC
     LIMIT ?`
  ).bind(userId, topK).all<MemoryItem>();

  return rows.results.map((item) => ({ ...item, source: "recent" }));
}

async function getMemoryItemsByIds(env: Env, ids: string[]): Promise<MemoryItem[]> {
  if (ids.length === 0) return [];

  const placeholders = ids.map(() => "?").join(", ");
  const rows = await env.DB.prepare(
    `SELECT *
     FROM memory_items
     WHERE id IN (${placeholders})`
  ).bind(...ids).all<MemoryItem>();

  const order = new Map(ids.map((id, index) => [id, index]));
  return rows.results.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

async function upsertMemoryVectors(
  env: Env,
  userId: string,
  memories: Array<{ id: string; text: string; role: string; createdAt: number; datePath: string }>
): Promise<void> {
  try {
    const vectors = await embedTexts(env, memories.map((memory) => memory.text));
    await env.MEMORY_INDEX.upsert(
      memories.map((memory, index) => ({
        id: memory.id,
        namespace: namespaceForUser(userId),
        values: vectors[index],
        metadata: {
          userId,
          role: memory.role,
          createdAt: memory.createdAt,
          datePath: memory.datePath
        }
      }))
    );
  } catch (error) {
    console.warn("Memory vector upsert failed", error);
  }
}

async function purgeOldMemory(env: Env, userId: string): Promise<void> {
  const maxItems = numberFromEnv(env.MEMORY_MAX_ITEMS, 50_000);
  if (maxItems <= 0) return;

  const countRow = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM memory_items WHERE discord_user_id = ?`
  ).bind(userId).first<{ count: number }>();
  const excess = Math.max(0, (countRow?.count ?? 0) - maxItems);
  if (excess === 0) return;

  const rows = await env.DB.prepare(
    `SELECT id
     FROM memory_items
     WHERE discord_user_id = ?
     ORDER BY created_at ASC
     LIMIT ?`
  ).bind(userId, excess).all<{ id: string }>();
  const ids = rows.results.map((row) => row.id);
  await deleteVectors(env, ids);

  for (const chunk of chunks(ids, 100)) {
    const placeholders = chunk.map(() => "?").join(", ");
    await env.DB.prepare(`DELETE FROM memory_items WHERE id IN (${placeholders})`)
      .bind(...chunk)
      .run();
  }
}

async function deleteVectors(env: Env, ids: string[]): Promise<void> {
  for (const chunk of chunks(ids, 100)) {
    try {
      await env.MEMORY_INDEX.deleteByIds(chunk);
    } catch (error) {
      console.warn("Vector delete failed", error);
    }
  }
}

async function embedTexts(env: Env, texts: string[]): Promise<number[][]> {
  const response = await env.AI.run(env.EMBEDDING_MODEL as string & {}, {
    text: texts
  }) as EmbeddingResponse;

  const data = response.data ?? response.result?.data;
  if (!data || data.length !== texts.length) {
    throw new Error("Unexpected embedding response shape");
  }
  return data;
}

function formatMemoryItems(items: MemoryItem[]): string {
  if (items.length === 0) return "";

  return items
    .sort((a, b) => a.created_at - b.created_at)
    .map((item) => {
      const source = item.source ? `/${item.source}` : "";
      const score = item.score === undefined ? "" : ` score=${item.score.toFixed(3)}`;
      return `- [${item.date_path}${source}${score}] ${item.role}: ${compactWhitespace(item.content)}`;
    })
    .join("\n");
}

function dedupeMemory(items: MemoryItem[]): MemoryItem[] {
  const seen = new Set<string>();
  const result: MemoryItem[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    result.push(item);
  }
  return result;
}

function extractSearchTerms(query: string): string[] {
  return [...new Set(query
    .replace(/[^\p{L}\p{N}\sぁ-んァ-ヶー一-龠]/gu, " ")
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2)
  )];
}

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function compactWhitespace(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > 360 ? `${compact.slice(0, 357)}...` : compact;
}

function numberFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function namespaceForUser(userId: string): string {
  return `u:${userId}`;
}

function makeMemoryId(userId: string): string {
  return `${userId}-${crypto.randomUUID()}`;
}

function dateParts(timestamp: number, timeZone = "Asia/Tokyo"): { createdDate: string; datePath: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(timestamp));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  const year = get("year");
  const month = get("month");
  const day = get("day");
  return {
    createdDate: `${year}-${month}-${day}`,
    datePath: `${year}/${month}/${day}`
  };
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}
