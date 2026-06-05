import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import type { StorageBackend } from "../storage";

export interface S3Config {
  endpoint: string;
  region: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
}

export class S3Backend implements StorageBackend {
  private client: S3Client;
  private bucket: string;

  constructor(config: S3Config) {
    this.bucket = config.bucket;
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region || "auto",
      credentials: {
        accessKeyId: config.accessKey,
        secretAccessKey: config.secretKey,
      },
      forcePathStyle: false,
    });
  }

  async put(key: string, data: ArrayBuffer): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: new Uint8Array(data),
      })
    );
  }

  async get(key: string): Promise<ArrayBuffer | null> {
    try {
      const res = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
          ResponseCacheControl: "no-store",
        })
      );
      const bytes = await res.Body?.transformToByteArray();
      return bytes ? (bytes.buffer as ArrayBuffer) : null;
    } catch (e: any) {
      if (e.name === "NoSuchKey" || e.$metadata?.httpStatusCode === 404) {
        return null;
      }
      throw e;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key })
    );
  }

  async test(): Promise<{ ok: boolean; error?: string }> {
    try {
      const payload = new TextEncoder().encode(`{"test":true,"t":${Date.now()}}`);
      await this.put("_thoth/test.json", payload.buffer);

      const result = await this.get("_thoth/test.json");
      if (!result) {
        return { ok: false, error: "Write succeeded but read returned null" };
      }

      await this.delete("_thoth/test.json");
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e.name || e.message };
    }
  }
}
