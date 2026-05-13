import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { createReadStream } from "node:fs";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { Readable } from "node:stream";

export interface StateSyncConfig {
  accountId?: string;
  bucket?: string;
  prefix?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  codexHome: string;
}

export class R2StateSync {
  private restored = false;
  private readonly client: S3Client | null;
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly codexHome: string;

  constructor(config: StateSyncConfig) {
    this.bucket = config.bucket ?? "";
    this.prefix = trimSlashes(config.prefix ?? "codex-state/main");
    this.codexHome = config.codexHome;

    if (config.accountId && config.bucket && config.accessKeyId && config.secretAccessKey) {
      this.client = new S3Client({
        region: "auto",
        endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
        credentials: {
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey
        }
      });
    } else {
      this.client = null;
    }
  }

  async restoreOnce(): Promise<void> {
    if (this.restored) return;
    this.restored = true;
    await mkdir(this.codexHome, { recursive: true, mode: 0o700 });

    if (!this.client) {
      console.warn("R2 state sync is not configured; using ephemeral local CODEX_HOME");
      return;
    }

    let continuationToken: string | undefined;
    do {
      const listed = await this.client.send(new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: `${this.prefix}/`,
        ContinuationToken: continuationToken
      }));

      for (const object of listed.Contents ?? []) {
        if (!object.Key || object.Key.endsWith("/")) continue;
        const localPath = join(this.codexHome, object.Key.slice(this.prefix.length + 1));
        await mkdir(dirname(localPath), { recursive: true });
        const fetched = await this.client.send(new GetObjectCommand({
          Bucket: this.bucket,
          Key: object.Key
        }));
        if (!fetched.Body) continue;
        await writeFile(localPath, await streamToBuffer(fetched.Body as Readable));
      }

      continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (continuationToken);
  }

  async syncNow(): Promise<void> {
    if (!this.client) return;
    await mkdir(this.codexHome, { recursive: true, mode: 0o700 });
    const files = await listFiles(this.codexHome);

    for (const file of files) {
      const key = `${this.prefix}/${relative(this.codexHome, file)}`;
      await this.client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: createReadStream(file)
      }));
    }
  }
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(fullPath));
    } else if (entry.isFile()) {
      const info = await stat(fullPath);
      if (info.size > 0) files.push(fullPath);
    }
  }
  return files;
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}
