import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir } from "node:fs/promises";
import { CodexService } from "./codex.js";
import { R2StateSync } from "./state.js";

const port = Number(process.env.PORT ?? 8789);
const codexHome = process.env.CODEX_HOME || "/home/codex/.codex";
const workspace = process.env.WORKSPACE_DIR || "/workspace";

const stateSync = new R2StateSync({
  accountId: process.env.R2_ACCOUNT_ID,
  bucket: process.env.R2_BUCKET_NAME,
  prefix: process.env.R2_STATE_PREFIX,
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  codexHome
});
const codex = new CodexService(stateSync, codexHome, workspace);

await mkdir(codexHome, { recursive: true, mode: 0o700 });
await mkdir(workspace, { recursive: true });
await stateSync.restoreOnce();

createServer(async (request, response) => {
  try {
    if (request.url === "/health") {
      return sendJson(response, 200, { ok: true });
    }

    if (!authorized(request)) {
      return sendJson(response, 401, { error: "unauthorized" });
    }

    if (request.method === "GET" && request.url === "/auth/status") {
      return sendJson(response, 200, await codex.authStatus());
    }

    if (request.method === "POST" && request.url === "/auth/start") {
      return sendJson(response, 200, await codex.startDeviceAuth());
    }

    if (request.method === "POST" && request.url === "/chat") {
      const body = await readJson<{ prompt?: string; model?: string }>(request);
      if (!body.prompt) return sendJson(response, 400, { error: "prompt is required" });
      return sendJson(response, 200, await codex.chat(body.prompt, body.model || process.env.CODEX_MODEL));
    }

    return sendJson(response, 404, { error: "not found" });
  } catch (error) {
    console.error(error);
    return sendJson(response, 500, {
      error: error instanceof Error ? error.message : String(error)
    });
  }
}).listen(port, "0.0.0.0", () => {
  console.log(`codex runner listening on ${port}`);
});

function authorized(request: IncomingMessage): boolean {
  const expected = process.env.RUNNER_SHARED_SECRET;
  if (!expected) return false;
  return request.headers.authorization === `Bearer ${expected}`;
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) as T : {} as T;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(body));
}
