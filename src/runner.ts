import { getContainer } from "@cloudflare/containers";
import type { Env, RunnerChatRequest, RunnerChatResponse } from "./types";

export async function callRunner<TResponse>(
  env: Env,
  path: string,
  body?: unknown,
  init?: RequestInit
): Promise<TResponse> {
  if ((env.RUNNER_BACKEND || "container") === "http") {
    return callHttpRunner<TResponse>(env, path, body, init);
  }

  return callContainerRunner<TResponse>(env, path, body, init);
}

export function runCodexChat(
  env: Env,
  request: RunnerChatRequest
): Promise<RunnerChatResponse> {
  return callRunner<RunnerChatResponse>(env, "/chat", request);
}

async function callContainerRunner<TResponse>(
  env: Env,
  path: string,
  body?: unknown,
  init?: RequestInit
): Promise<TResponse> {
  if (!env.CODEX_RUNNER) {
    throw new Error("CODEX_RUNNER binding is required when RUNNER_BACKEND=container");
  }

  const container = getContainer(env.CODEX_RUNNER, "main");
  await container.startAndWaitForPorts({
    ports: [8789],
    startOptions: {
      envVars: runnerEnv(env)
    },
    cancellationOptions: {
      instanceGetTimeoutMS: 15_000,
      portReadyTimeoutMS: 60_000
    }
  });

  const response = await container.fetch(
    new Request(`http://codex-runner.local${path}`, {
      method: body === undefined ? "GET" : "POST",
      ...init,
      headers: {
        "authorization": `Bearer ${env.RUNNER_SHARED_SECRET}`,
        "content-type": "application/json",
        ...(init?.headers ?? {})
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Runner ${path} failed: ${response.status} ${text}`);
  }

  return response.json() as Promise<TResponse>;
}

async function callHttpRunner<TResponse>(
  env: Env,
  path: string,
  body?: unknown,
  init?: RequestInit
): Promise<TResponse> {
  if (!env.RUNNER_HTTP_BASE_URL) {
    throw new Error("RUNNER_HTTP_BASE_URL is required when RUNNER_BACKEND=http");
  }

  const url = new URL(path, ensureTrailingSlash(env.RUNNER_HTTP_BASE_URL));
  const response = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    ...init,
    headers: {
      "authorization": `Bearer ${env.RUNNER_SHARED_SECRET}`,
      "content-type": "application/json",
      ...(init?.headers ?? {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP runner ${path} failed: ${response.status} ${text}`);
  }

  return response.json() as Promise<TResponse>;
}

function runnerEnv(env: Env): Record<string, string> {
  return compactStrings({
    RUNNER_SHARED_SECRET: env.RUNNER_SHARED_SECRET,
    AWS_ACCESS_KEY_ID: env.AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: env.AWS_SECRET_ACCESS_KEY,
    R2_ACCOUNT_ID: env.R2_ACCOUNT_ID,
    R2_BUCKET_NAME: env.R2_BUCKET_NAME,
    R2_STATE_PREFIX: env.R2_STATE_PREFIX,
    CODEX_MODEL: env.CODEX_MODEL,
    CODEX_HOME: "/home/codex/.codex",
    HOME: "/home/codex",
    NODE_ENV: "production"
  });
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

function compactStrings(values: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, string] => Boolean(entry[1]))
  );
}
