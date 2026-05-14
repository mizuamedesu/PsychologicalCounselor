import type {
  Env,
  PersonaContext,
  PersonaEdge,
  PersonaExpansion,
  PersonaNode,
  PersonaProfile
} from "./types";

type ParsedSeed = {
  name?: string;
  age?: number;
  affiliation?: string;
  speechStyle?: string;
  relationship?: string;
  traits: string[];
};

type NewNode = {
  id: string;
  nodeType: string;
  label: string;
  content: string;
  confidence: number;
  metadata: Record<string, unknown>;
};

export function personaSetupPrompt(): string {
  return [
    "先に私のペルソナを決めたい。",
    "3〜6行くらいで、ざっくり材料を送ってください。",
    "",
    "例:",
    "名前はゆい、21歳、お茶の水女子大に通う。",
    "話し方はやわらかめで、少し砕けてる。",
    "あなたとの距離感は、親しいDM相手くらい。",
    "",
    "足りない部分は、この初期人格を元にあとから少しずつ過去の出来事として拡張していきます。"
  ].join("\n");
}

export async function getPersonaProfile(
  env: Env,
  userId: string
): Promise<PersonaProfile | null> {
  return env.DB.prepare(
    `SELECT * FROM persona_profiles WHERE discord_user_id = ?`
  ).bind(userId).first<PersonaProfile>();
}

export async function ensurePersonaProfile(
  env: Env,
  userId: string,
  now = Date.now()
): Promise<PersonaProfile> {
  const existing = await getPersonaProfile(env, userId);
  if (existing) return existing;

  await env.DB.prepare(
    `INSERT INTO persona_profiles (
       discord_user_id,
       status,
       style_json,
       created_at,
       updated_at
     )
     VALUES (?, 'needs_seed', '{}', ?, ?)`
  ).bind(userId, now, now).run();

  const created = await getPersonaProfile(env, userId);
  if (!created) throw new Error("persona profile creation failed");
  return created;
}

export async function personaNeedsSeed(env: Env, userId: string): Promise<boolean> {
  const profile = await ensurePersonaProfile(env, userId);
  return profile.status !== "active";
}

export function looksLikePersonaSeed(seed: string): boolean {
  const parsed = parsePersonaSeed(seed);
  let signals = 0;
  if (parsed.name) signals += 1;
  if (parsed.age) signals += 1;
  if (parsed.affiliation) signals += 1;
  if (parsed.speechStyle) signals += 1;
  if (parsed.relationship) signals += 1;
  if (/ペルソナ|persona|名前|年齢|歳|所属|大学|高校|学校|会社|勤務|通う|話し方|口調|距離感|関係/i.test(seed)) {
    signals += 1;
  }
  return seed.trim().length >= 8 && signals >= 2;
}

export async function initializePersonaFromSeed(input: {
  env: Env;
  userId: string;
  seed: string;
  now?: number;
}): Promise<{
  profile: PersonaProfile;
  nodes: PersonaNode[];
  summary: string;
}> {
  const now = input.now ?? Date.now();
  const seed = input.seed.trim();
  const parsed = parsePersonaSeed(seed);
  const summary = buildSummary(parsed, seed);
  const displayName = parsed.name ?? null;
  const root = makeNode(input.userId, "identity", "persona", summary, 1, {
    source: "initial_seed",
    fictional: true
  });
  const nodes: NewNode[] = [
    root,
    makeNode(input.userId, "event", "初期ペルソナ設定", `ユーザーの初期入力から創作ペルソナを確定した: ${seed}`, 1, {
      source: "initial_seed",
      fictional: true
    }),
    makeNode(input.userId, "trait", "基本姿勢", "相談相手として、急かさず、親しさと落ち着きを両方持って返事をする。", 0.82, {
      source: "default_from_seed",
      fictional: true
    })
  ];

  if (parsed.name) {
    nodes.push(makeNode(input.userId, "identity", "名前", parsed.name, 0.96, {
      source: "initial_seed",
      fictional: true
    }));
  }
  if (parsed.age) {
    nodes.push(makeNode(input.userId, "identity", "年齢", `${parsed.age}歳`, 0.94, {
      source: "initial_seed",
      fictional: true
    }));
  }
  if (parsed.affiliation) {
    nodes.push(makeNode(input.userId, "affiliation", "所属/生活", parsed.affiliation, 0.88, {
      source: "initial_seed",
      fictional: true
    }));
  }
  if (parsed.speechStyle) {
    nodes.push(makeNode(input.userId, "speech_style", "話し方", parsed.speechStyle, 0.86, {
      source: "initial_seed",
      fictional: true
    }));
  }
  if (parsed.relationship) {
    nodes.push(makeNode(input.userId, "relationship", "ユーザーとの距離感", parsed.relationship, 0.84, {
      source: "initial_seed",
      fictional: true
    }));
  }
  for (const trait of parsed.traits.slice(0, 4)) {
    nodes.push(makeNode(input.userId, "trait", "性格/雰囲気", trait, 0.72, {
      source: "initial_seed",
      fictional: true
    }));
  }

  const edgeTypeByNodeType: Record<string, string> = {
    identity: "has_identity",
    affiliation: "belongs_to",
    speech_style: "speaks_with",
    relationship: "relates_as",
    trait: "has_trait",
    event: "has_event"
  };
  const edges = nodes
    .filter((node) => node.id !== root.id)
    .map((node) => ({
      id: crypto.randomUUID(),
      sourceId: root.id,
      targetId: node.id,
      edgeType: edgeTypeByNodeType[node.nodeType] ?? "has_detail"
    }));
  const style = {
    name: parsed.name ?? null,
    age: parsed.age ?? null,
    affiliation: parsed.affiliation ?? null,
    speechStyle: parsed.speechStyle ?? "やわらかく、少し親しげ",
    relationship: parsed.relationship ?? "親しいDM相手",
    fictional: true
  };
  const nextExpandAt = now + randomInt(30 * 60_000, 2 * 60 * 60_000);
  const statements: D1PreparedStatement[] = [
    input.env.DB.prepare(`DELETE FROM persona_edges WHERE discord_user_id = ?`).bind(input.userId),
    input.env.DB.prepare(`DELETE FROM persona_nodes WHERE discord_user_id = ?`).bind(input.userId),
    input.env.DB.prepare(
      `INSERT INTO persona_profiles (
         discord_user_id,
         status,
         display_name,
         seed_text,
         summary,
         style_json,
         created_at,
         updated_at,
         last_expanded_at,
         next_expand_at
       )
       VALUES (?, 'active', ?, ?, ?, ?, ?, ?, NULL, ?)
       ON CONFLICT(discord_user_id) DO UPDATE SET
         status = 'active',
         display_name = excluded.display_name,
         seed_text = excluded.seed_text,
         summary = excluded.summary,
         style_json = excluded.style_json,
         updated_at = excluded.updated_at,
         last_expanded_at = NULL,
         next_expand_at = excluded.next_expand_at`
    ).bind(
      input.userId,
      displayName,
      seed,
      summary,
      JSON.stringify(style),
      now,
      now,
      nextExpandAt
    )
  ];

  for (const node of nodes) {
    statements.push(
      input.env.DB.prepare(
        `INSERT INTO persona_nodes (
           id,
           discord_user_id,
           node_type,
           label,
           content,
           confidence,
           created_at,
           updated_at,
           metadata_json
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        node.id,
        input.userId,
        node.nodeType,
        node.label,
        node.content,
        node.confidence,
        now,
        now,
        JSON.stringify(node.metadata)
      )
    );
  }

  for (const edge of edges) {
    statements.push(
      input.env.DB.prepare(
        `INSERT INTO persona_edges (
           id,
           discord_user_id,
           source_id,
           target_id,
           edge_type,
           weight,
           created_at,
           metadata_json
         )
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
      ).bind(
        edge.id,
        input.userId,
        edge.sourceId,
        edge.targetId,
        edge.edgeType,
        now,
        JSON.stringify({ source: "initial_seed", fictional: true })
      )
    );
  }

  statements.push(
    input.env.DB.prepare(
      `INSERT INTO persona_events (id, discord_user_id, event_type, detail_json, created_at)
       VALUES (?, ?, 'seed_initialized', ?, ?)`
    ).bind(
      crypto.randomUUID(),
      input.userId,
      JSON.stringify({
        summary,
        seed,
        nodeCount: nodes.length,
        edgeCount: edges.length
      }),
      now
    )
  );

  await input.env.DB.batch(statements);
  const profile = await getPersonaProfile(input.env, input.userId);
  if (!profile) throw new Error("persona profile activation failed");
  return {
    profile,
    nodes: await getPersonaNodes(input.env, input.userId, 40),
    summary
  };
}

export function personaBotUsername(profile: PersonaProfile): string | undefined {
  const base = profile.display_name?.trim();
  if (!base) return undefined;
  const sanitized = sanitizeDiscordUsername(base);
  return sanitized.length >= 2 ? sanitized : undefined;
}

export async function buildPersonaContext(env: Env, userId: string): Promise<PersonaContext> {
  const profile = await getPersonaProfile(env, userId);
  if (!profile || profile.status !== "active") {
    return {
      profile,
      nodes: [],
      edges: [],
      formatted: [
        "Fictional persona graph is not configured yet.",
        "Before normal conversation, ask the user to provide a short seed persona."
      ].join("\n")
    };
  }

  const [nodes, edgeRows] = await Promise.all([
    getPersonaNodes(env, userId, 36),
    env.DB.prepare(
      `SELECT *
       FROM persona_edges
       WHERE discord_user_id = ?
       ORDER BY created_at DESC
       LIMIT 50`
    ).bind(userId).all<PersonaEdge>()
  ]);

  return {
    profile,
    nodes,
    edges: edgeRows.results,
    formatted: formatPersonaContext(profile, nodes)
  };
}

export async function expandDuePersonaWorlds(input: {
  env: Env;
  limit: number;
  force?: boolean;
  now?: number;
}): Promise<PersonaExpansion[]> {
  const now = input.now ?? Date.now();
  const ownerId = input.env.OWNER_DISCORD_USER_ID;
  const rows = await input.env.DB.prepare(
    `SELECT *
     FROM persona_profiles
     WHERE status = 'active'
       AND (? = 1 OR next_expand_at IS NULL OR next_expand_at <= ?)
       AND (? = '' OR discord_user_id = ?)
     ORDER BY COALESCE(next_expand_at, 0) ASC
     LIMIT ?`
  ).bind(
    input.force ? 1 : 0,
    now,
    ownerId ? ownerId : "",
    ownerId ? ownerId : "",
    Math.max(1, Math.min(input.limit, 5))
  ).all<PersonaProfile>();

  const expansions: PersonaExpansion[] = [];
  for (const profile of rows.results) {
    expansions.push(await expandPersonaWorld(input.env, profile, now));
  }
  return expansions;
}

export async function formatPersonaStatus(env: Env, userId: string): Promise<string> {
  const profile = await getPersonaProfile(env, userId);
  if (!profile) return "persona: not started";
  if (profile.status !== "active") return "persona: waiting for seed";

  const count = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM persona_nodes WHERE discord_user_id = ?`
  ).bind(userId).first<{ count: number }>();

  return [
    `persona: ${profile.display_name ?? "active"} (${count?.count ?? 0} nodes)`,
    profile.summary ? `summary: ${profile.summary}` : undefined,
    profile.next_expand_at ? `next expansion: ${new Date(profile.next_expand_at).toISOString()}` : undefined
  ].filter(Boolean).join("\n");
}

export async function resetPersona(env: Env, userId: string, now = Date.now()): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM persona_edges WHERE discord_user_id = ?`).bind(userId),
    env.DB.prepare(`DELETE FROM persona_nodes WHERE discord_user_id = ?`).bind(userId),
    env.DB.prepare(
      `INSERT INTO persona_profiles (
         discord_user_id,
         status,
         style_json,
         created_at,
         updated_at
       )
       VALUES (?, 'needs_seed', '{}', ?, ?)
       ON CONFLICT(discord_user_id) DO UPDATE SET
         status = 'needs_seed',
         display_name = NULL,
         seed_text = NULL,
         summary = NULL,
         style_json = '{}',
         updated_at = excluded.updated_at,
         last_expanded_at = NULL,
         next_expand_at = NULL`
    ).bind(userId, now, now),
    env.DB.prepare(
      `INSERT INTO persona_events (id, discord_user_id, event_type, detail_json, created_at)
       VALUES (?, ?, 'persona_reset', '{}', ?)`
    ).bind(crypto.randomUUID(), userId, now)
  ]);
}

async function expandPersonaWorld(
  env: Env,
  profile: PersonaProfile,
  now: number
): Promise<PersonaExpansion> {
  const nodes = await getPersonaNodes(env, profile.discord_user_id, 80);
  const root = nodes.find((node) => node.node_type === "identity" && node.label === "persona") ?? nodes[0];
  if (!root) {
    return { userId: profile.discord_user_id, expanded: false };
  }

  const eventCount = nodes.filter((node) => node.node_type === "event").length;
  const detail = chooseBackstoryDetail(profile, nodes, eventCount);
  const nodeId = crypto.randomUUID();
  const nextExpandAt = now + randomInt(3 * 60 * 60_000, 9 * 60 * 60_000);

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO persona_nodes (
         id,
         discord_user_id,
         node_type,
         label,
         content,
         confidence,
         created_at,
         updated_at,
         metadata_json
       )
       VALUES (?, ?, 'event', ?, ?, 0.64, ?, ?, ?)`
    ).bind(
      nodeId,
      profile.discord_user_id,
      detail.label,
      detail.content,
      now,
      now,
      JSON.stringify({ source: "auto_world_expansion", fictional: true })
    ),
    env.DB.prepare(
      `INSERT INTO persona_edges (
         id,
         discord_user_id,
         source_id,
         target_id,
         edge_type,
         weight,
         created_at,
         metadata_json
       )
       VALUES (?, ?, ?, ?, 'experienced', 0.65, ?, ?)`
    ).bind(
      crypto.randomUUID(),
      profile.discord_user_id,
      root.id,
      nodeId,
      now,
      JSON.stringify({ source: "auto_world_expansion", fictional: true })
    ),
    env.DB.prepare(
      `INSERT INTO persona_events (id, discord_user_id, event_type, detail_json, created_at)
       VALUES (?, ?, 'world_expanded', ?, ?)`
    ).bind(
      crypto.randomUUID(),
      profile.discord_user_id,
      JSON.stringify({ nodeId, label: detail.label }),
      now
    ),
    env.DB.prepare(
      `UPDATE persona_profiles
       SET last_expanded_at = ?,
           next_expand_at = ?,
           updated_at = ?
       WHERE discord_user_id = ?`
    ).bind(now, nextExpandAt, now, profile.discord_user_id)
  ]);

  return {
    userId: profile.discord_user_id,
    expanded: true,
    nodeId,
    nextExpandAt
  };
}

async function getPersonaNodes(env: Env, userId: string, limit: number): Promise<PersonaNode[]> {
  const rows = await env.DB.prepare(
    `SELECT *
     FROM persona_nodes
     WHERE discord_user_id = ?
     ORDER BY
       CASE node_type
         WHEN 'identity' THEN 0
         WHEN 'affiliation' THEN 1
         WHEN 'speech_style' THEN 2
         WHEN 'relationship' THEN 3
         WHEN 'trait' THEN 4
         WHEN 'event' THEN 5
         ELSE 9
       END,
       created_at DESC
     LIMIT ?`
  ).bind(userId, Math.max(1, Math.min(limit, 120))).all<PersonaNode>();
  return rows.results;
}

function parsePersonaSeed(seed: string): ParsedSeed {
  const lines = seed.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const name = firstMatch(seed, [
    /(?:名前|name)\s*(?:は|[:：])\s*([^\s、。,\n]{1,32})/i,
    /^([^\s、。,\n]{1,24})[、,]\s*\d{1,3}\s*歳/
  ]);
  const ageText = firstMatch(seed, [/(\d{1,3})\s*歳/]);
  const age = ageText ? Number(ageText) : undefined;
  const affiliation = headingValue(lines, /(所属|生活|学校|大学|高校|会社|勤務)/)
    ?? sentenceAround(seed, /(大学|高校|学校|会社|勤務|通う|院生|専門)/);
  const speechStyle = headingValue(lines, /(話し方|口調|喋り方|しゃべり方)/)
    ?? sentenceAround(seed, /(話し方|口調|喋り方|しゃべり方|やわらか|砕け|敬語|タメ口)/);
  const relationship = headingValue(lines, /(距離感|関係|あなた|ユーザー)/)
    ?? sentenceAround(seed, /(距離感|親しい|友達|恋人|相棒|相談相手|DM相手)/);
  const traits = lines
    .filter((line) => /(性格|雰囲気|気質|好き|苦手)/.test(line))
    .map(stripHeading)
    .filter((line) => line.length >= 2);

  return {
    name: cleanShort(name),
    age: age && age > 0 && age < 120 ? age : undefined,
    affiliation: cleanSentence(affiliation),
    speechStyle: cleanSentence(speechStyle),
    relationship: cleanSentence(relationship),
    traits
  };
}

function buildSummary(parsed: ParsedSeed, seed: string): string {
  const parts = [
    parsed.name ? `名前は${parsed.name}` : undefined,
    parsed.age ? `${parsed.age}歳` : undefined,
    parsed.affiliation,
    parsed.speechStyle ? `話し方は${parsed.speechStyle}` : undefined,
    parsed.relationship ? `ユーザーとの距離感は${parsed.relationship}` : undefined
  ].filter(Boolean);

  if (parts.length > 0) {
    return `創作ペルソナ: ${parts.join("、")}。`;
  }
  return `創作ペルソナ: ${truncate(seed, 160)}`;
}

function formatPersonaContext(profile: PersonaProfile, nodes: PersonaNode[]): string {
  return [
    "Fictional persona graph:",
    "- Treat this as role/persona continuity for the bot, not as verified real-world identity.",
    profile.summary ? `- Summary: ${profile.summary}` : undefined,
    profile.last_expanded_at ? `- Last world expansion: ${new Date(profile.last_expanded_at).toISOString()}.` : undefined,
    "",
    ...nodes.slice(0, 28).map((node) =>
      `- [${node.node_type}] ${node.label}: ${node.content} (confidence ${node.confidence.toFixed(2)})`
    )
  ].filter((line): line is string => line !== undefined).join("\n");
}

function chooseBackstoryDetail(
  profile: PersonaProfile,
  nodes: PersonaNode[],
  eventCount: number
): { label: string; content: string } {
  const name = profile.display_name ?? findNodeContent(nodes, "identity", "名前") ?? "この子";
  const affiliation = findNodeContent(nodes, "affiliation", "所属/生活");
  const speech = findNodeContent(nodes, "speech_style", "話し方") ?? "やわらかく返す";
  const templates = [
    {
      label: "過去の小さな癖",
      content: `${name}は、相手の言葉をすぐ結論にせず、一度だけ自分の中で言い換えてから返す癖がある。`
    },
    {
      label: "生活のリズム",
      content: affiliation
        ? `${affiliation}日でも、夜はDMの空気に戻ってきやすい。`
        : `${name}は夜になると、短い雑談や相談に意識を向けやすい。`
    },
    {
      label: "返事の距離感",
      content: `${name}は${speech}ことを大事にしていて、重い話でも急に正論で押さない。`
    },
    {
      label: "昔の出来事",
      content: `${name}は以前、誰かに急かされて話すより、少し間を置いた方が本音が出ると感じたことがある。`
    },
    {
      label: "好きな空気",
      content: `${name}は、何かを解決しきらないままでも隣に置いておけるDMの空気を好む。`
    }
  ];
  return templates[eventCount % templates.length];
}

function findNodeContent(nodes: PersonaNode[], nodeType: string, label: string): string | undefined {
  return nodes.find((node) => node.node_type === nodeType && node.label === label)?.content;
}

function makeNode(
  userId: string,
  nodeType: string,
  label: string,
  content: string,
  confidence: number,
  metadata: Record<string, unknown>
): NewNode {
  return {
    id: crypto.randomUUID(),
    nodeType,
    label,
    content: truncate(content.trim(), 500),
    confidence,
    metadata: {
      ...metadata,
      discordUserId: userId
    }
  };
}

function headingValue(lines: string[], pattern: RegExp): string | undefined {
  const line = lines.find((item) => pattern.test(item));
  return line ? stripHeading(line) : undefined;
}

function stripHeading(line: string): string {
  return line.replace(/^[^:：]{1,16}[:：]\s*/, "").replace(/^(名前|年齢|所属|生活|話し方|口調|距離感|関係)\s*は?\s*/, "").trim();
}

function sentenceAround(text: string, pattern: RegExp): string | undefined {
  const sentences = text.split(/[。\n]/).map((line) => line.trim()).filter(Boolean);
  return sentences.find((sentence) => pattern.test(sentence));
}

function firstMatch(text: string, patterns: RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return undefined;
}

function cleanShort(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return truncate(value.replace(/[「」"']/g, "").trim(), 40) || undefined;
}

function cleanSentence(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return truncate(value.replace(/\s+/g, " ").trim(), 180) || undefined;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function sanitizeDiscordUsername(value: string): string {
  const sanitized = value
    .replace(/[@#:`]/g, "")
    .replace(/discord/ig, "d")
    .replace(/\s+/g, " ")
    .trim();
  const lowered = sanitized.toLowerCase();
  if (lowered === "everyone" || lowered === "here") return `${sanitized}_`;
  return truncate(sanitized, 32);
}

function randomInt(min: number, max: number): number {
  const low = Math.ceil(Math.min(min, max));
  const high = Math.floor(Math.max(min, max));
  const range = high - low + 1;
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return low + (bytes[0] % range);
}
