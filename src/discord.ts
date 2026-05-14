import nacl from "tweetnacl";
import type { DiscordInteraction, DiscordOption } from "./types";

export const DiscordInteractionType = {
  Ping: 1,
  ApplicationCommand: 2
} as const;

export const DiscordInteractionResponseType = {
  Pong: 1,
  ChannelMessageWithSource: 4,
  DeferredChannelMessageWithSource: 5
} as const;

export const DiscordMessageFlags = {
  Ephemeral: 1 << 6
} as const;

export function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init?.headers ?? {})
    }
  });
}

export function immediateMessage(content: string, ephemeral = true): Response {
  return jsonResponse({
    type: DiscordInteractionResponseType.ChannelMessageWithSource,
    data: {
      content,
      flags: ephemeral ? DiscordMessageFlags.Ephemeral : undefined
    }
  });
}

export function deferredMessage(ephemeral = true): Response {
  return jsonResponse({
    type: DiscordInteractionResponseType.DeferredChannelMessageWithSource,
    data: {
      flags: ephemeral ? DiscordMessageFlags.Ephemeral : undefined
    }
  });
}

export async function editOriginalInteraction(
  applicationId: string,
  interactionToken: string,
  content: string
): Promise<void> {
  const response = await fetch(
    `https://discord.com/api/v10/webhooks/${applicationId}/${interactionToken}/messages/@original`,
    {
      method: "PATCH",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({ content: truncateDiscord(content) })
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Discord webhook edit failed: ${response.status} ${text}`);
  }
}

export function truncateDiscord(content: string): string {
  if (content.length <= 1900) return content;
  return `${content.slice(0, 1890)}\n...`;
}

export function getOption<T extends string | number | boolean>(
  options: DiscordOption[] | undefined,
  name: string
): T | undefined {
  return options?.find((option) => option.name === name)?.value as T | undefined;
}

export function interactionUserId(interaction: DiscordInteraction): string | null {
  return interaction.member?.user?.id ?? interaction.user?.id ?? null;
}

export function isOwner(
  interaction: DiscordInteraction,
  ownerId: string,
  ownerUsername?: string
): boolean {
  const user = interaction.member?.user ?? interaction.user;
  const userId = user?.id ?? null;
  return isOwnerIdentity({
    userId,
    usernames: user?.username ? [user.username] : [],
    ownerId,
    ownerUsername
  });
}

export function isOwnerIdentity(input: {
  userId?: string | null;
  usernames?: Array<string | null | undefined>;
  ownerId: string;
  ownerUsername?: string;
}): boolean {
  if (input.userId && input.ownerId && input.userId === input.ownerId) return true;

  if (!input.ownerId && input.ownerUsername) {
    return Boolean(input.usernames?.some((username) =>
      username?.toLowerCase() === input.ownerUsername?.toLowerCase()
    ));
  }

  return false;
}

export async function readVerifiedDiscordInteraction(
  request: Request,
  publicKey: string
): Promise<DiscordInteraction | null> {
  const signature = request.headers.get("x-signature-ed25519");
  const timestamp = request.headers.get("x-signature-timestamp");
  const body = await request.text();

  if (!signature || !timestamp || !publicKey) return null;

  const verified = verifyDiscordSignature({ body, publicKey, signature, timestamp });
  if (!verified) return null;

  return JSON.parse(body) as DiscordInteraction;
}

function verifyDiscordSignature(input: {
  body: string;
  publicKey: string;
  signature: string;
  timestamp: string;
}): boolean {
  try {
    const message = new TextEncoder().encode(input.timestamp + input.body);
    return nacl.sign.detached.verify(
      message,
      hexToBytes(input.signature),
      hexToBytes(input.publicKey)
    );
  } catch {
    return false;
  }
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("Invalid hex string");
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < hex.length; index += 2) {
    bytes[index / 2] = Number.parseInt(hex.slice(index, index + 2), 16);
  }
  return bytes;
}
