import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";

const publicRootConfigPath = "wrangler.jsonc";
const publicContainerConfigPath = "wrangler.container.jsonc";
const rootConfigPath = "wrangler.local.jsonc";
const containerConfigPath = "wrangler.container.local.jsonc";
const appName = "psychological-counselor";
const d1Name = "psychological-counselor";
const vectorizeName = "psychological-counselor-memory";
const useContainer = process.argv.includes("--container");

const env = await loadDotEnv(".env");
const sharedSecret = env.RUNNER_SHARED_SECRET || randomBytes(32).toString("base64url");
if (!env.RUNNER_SHARED_SECRET) {
  env.RUNNER_SHARED_SECRET = sharedSecret;
  await writeDotEnv(".env", env);
  console.log("Generated RUNNER_SHARED_SECRET into .env");
}

const accountId = await getAccountId();
const d1Id = await ensureD1();
await ensureVectorize();
if (useContainer) await ensureR2(env, accountId);

await ensureLocalConfig(publicRootConfigPath, rootConfigPath);
await ensureLocalConfig(publicContainerConfigPath, containerConfigPath);
await updateWranglerConfig(rootConfigPath, {
  accountId,
  d1Id,
  env,
  runnerBackend: "http"
});
await updateWranglerConfig(containerConfigPath, {
  accountId,
  d1Id,
  env,
  runnerBackend: "container"
});

await putSecret("RUNNER_SHARED_SECRET", sharedSecret, useContainer ? containerConfigPath : rootConfigPath);

if (useContainer) {
  if (env.AWS_ACCESS_KEY_ID) await putSecret("AWS_ACCESS_KEY_ID", env.AWS_ACCESS_KEY_ID, containerConfigPath);
  if (env.AWS_SECRET_ACCESS_KEY) await putSecret("AWS_SECRET_ACCESS_KEY", env.AWS_SECRET_ACCESS_KEY, containerConfigPath);
}

await run("npx", ["wrangler", "d1", "migrations", "apply", d1Name, "--remote", "-c", rootConfigPath]);
await run("npx", ["wrangler", "deploy", "-c", useContainer ? containerConfigPath : rootConfigPath]);

console.log("Bootstrap and deploy complete.");

async function ensureD1(): Promise<string> {
  const existing = await findD1();
  if (existing) {
    console.log(`D1 exists: ${d1Name} (${existing.uuid})`);
    return existing.uuid;
  }

  console.log(`Creating D1: ${d1Name}`);
  await run("npx", ["wrangler", "d1", "create", d1Name, "--location", "apac"]);
  const created = await findD1();
  if (!created) throw new Error(`D1 was created but could not be found: ${d1Name}`);
  return created.uuid;
}

async function findD1(): Promise<{ uuid: string; name: string } | null> {
  const output = await capture("npx", ["wrangler", "d1", "list", "--json"]);
  const databases = JSON.parse(output) as Array<{ uuid: string; name: string }>;
  return databases.find((database) => database.name === d1Name) ?? null;
}

async function ensureVectorize(): Promise<void> {
  const output = await capture("npx", ["wrangler", "vectorize", "list", "--json"]);
  const indexes = JSON.parse(output) as Array<{ name?: string; id?: string }>;
  if (indexes.some((index) => index.name === vectorizeName || index.id === vectorizeName)) {
    console.log(`Vectorize exists: ${vectorizeName}`);
    return;
  }

  console.log(`Creating Vectorize index: ${vectorizeName}`);
  await run("npx", [
    "wrangler",
    "vectorize",
    "create",
    vectorizeName,
    "--dimensions=1024",
    "--metric=cosine"
  ]);
}

async function ensureR2(values: Record<string, string>, accountId: string): Promise<void> {
  const bucketName = values.R2_BUCKET_NAME || `psychological-counselor-codex-${accountId.slice(0, 8)}`;
  values.R2_ACCOUNT_ID = values.R2_ACCOUNT_ID || accountId;
  values.R2_BUCKET_NAME = bucketName;
  values.R2_STATE_PREFIX = values.R2_STATE_PREFIX || "codex-state/main";
  await writeDotEnv(".env", values);

  const output = await capture("npx", ["wrangler", "r2", "bucket", "list"]);
  if (new RegExp(`^name:\\s+${escapeRegex(bucketName)}$`, "m").test(output)) {
    console.log(`R2 exists: ${bucketName}`);
    return;
  }

  console.log(`Creating R2 bucket: ${bucketName}`);
  await run("npx", ["wrangler", "r2", "bucket", "create", bucketName, "--location", "apac"]);
}

async function updateWranglerConfig(path: string, input: {
  accountId: string;
  d1Id: string;
  env: Record<string, string>;
  runnerBackend: "http" | "container";
}): Promise<void> {
  const config = JSON.parse(await readFile(path, "utf8"));
  config.d1_databases ??= [];
  config.d1_databases[0] = {
    binding: "DB",
    database_name: d1Name,
    database_id: input.d1Id
  };

  config.vectorize ??= [];
  config.vectorize[0] = {
    binding: "MEMORY_INDEX",
    index_name: vectorizeName
  };

  config.ai = { binding: "AI" };
  config.vars ??= {};
  const vars = config.vars as Record<string, string>;

  copyEnv(vars, input.env, [
    "DISCORD_APPLICATION_ID",
    "DISCORD_PUBLIC_KEY",
    "OWNER_DISCORD_USER_ID",
    "OWNER_DISCORD_USERNAME",
    "COUNSELOR_LANGUAGE",
    "MEMORY_TIME_ZONE",
    "EMBEDDING_MODEL",
    "MEMORY_MAX_ITEMS",
    "MEMORY_VECTOR_TOP_K",
    "MEMORY_TEXT_TOP_K",
    "MEMORY_RECENT_TOP_K",
    "CODEX_MODEL",
    "RUNNER_HTTP_BASE_URL",
    "R2_BUCKET_NAME",
    "R2_STATE_PREFIX"
  ]);

  vars.R2_ACCOUNT_ID = input.env.R2_ACCOUNT_ID || input.accountId;
  vars.RUNNER_BACKEND = input.runnerBackend;
  if (input.runnerBackend === "container") {
    vars.RUNNER_HTTP_BASE_URL = "";
    vars.R2_BUCKET_NAME = input.env.R2_BUCKET_NAME || vars.R2_BUCKET_NAME || "";
    vars.R2_STATE_PREFIX = input.env.R2_STATE_PREFIX || vars.R2_STATE_PREFIX || "codex-state/main";
  } else {
    vars.RUNNER_HTTP_BASE_URL = input.env.RUNNER_HTTP_BASE_URL || vars.RUNNER_HTTP_BASE_URL || "https://codex-runner.example.com";
  }

  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
}

async function ensureLocalConfig(templatePath: string, localPath: string): Promise<void> {
  if (existsSync(localPath)) return;
  await writeFile(localPath, await readFile(templatePath, "utf8"));
}

async function putSecret(name: string, value: string, configPath: string): Promise<void> {
  console.log(`Putting Worker secret: ${name}`);
  await run("npx", ["wrangler", "secret", "put", name, "-c", configPath], value);
}

async function getAccountId(): Promise<string> {
  const output = await capture("npx", ["wrangler", "whoami"]);
  const match = output.match(/[a-f0-9]{32}/i);
  if (!match) throw new Error("Could not read Cloudflare account ID from wrangler whoami");
  return match[0];
}

async function loadDotEnv(path: string): Promise<Record<string, string>> {
  if (!existsSync(path)) return {};
  const text = await readFile(path, "utf8");
  const result: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const raw = trimmed.slice(index + 1).trim();
    result[key] = raw.replace(/^["']|["']$/g, "");
  }
  return result;
}

async function writeDotEnv(path: string, values: Record<string, string>): Promise<void> {
  const preferredOrder = [
    "DISCORD_APPLICATION_ID",
    "DISCORD_PUBLIC_KEY",
    "DISCORD_BOT_TOKEN",
    "DISCORD_GUILD_ID",
    "OWNER_DISCORD_USER_ID",
    "RUNNER_SHARED_SECRET",
    "RUNNER_BACKEND",
    "RUNNER_HTTP_BASE_URL",
    "CODEX_MODEL",
    "HOST_CODEX_HOME",
    "R2_ACCOUNT_ID",
    "R2_BUCKET_NAME",
    "R2_STATE_PREFIX",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY"
  ];
  const keys = [...preferredOrder, ...Object.keys(values).filter((key) => !preferredOrder.includes(key))];
  const body = keys
    .filter((key, index) => keys.indexOf(key) === index)
    .map((key) => `${key}=${values[key] ?? ""}`)
    .join("\n");
  await writeFile(path, `${body}\n`);
}

function copyEnv(target: Record<string, string>, source: Record<string, string>, keys: string[]): void {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) target[key] = source[key];
  }
}

function run(command: string, args: string[], input?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: input === undefined ? "inherit" : ["pipe", "inherit", "inherit"]
    });
    if (input !== undefined) {
      if (!child.stdin) {
        reject(new Error("Child stdin is unavailable"));
        return;
      }
      child.stdin.end(input);
    }
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
    });
  });
}

function capture(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => stdout += String(chunk));
    child.stderr.on("data", (chunk) => stderr += String(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code}\n${stderr}`));
    });
  });
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
