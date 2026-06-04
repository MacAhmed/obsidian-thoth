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
        new GetObjectCommand({ Bucket: this.bucket, Key: key })
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
      console.log("[thoth] test: starting connection test");
      console.log("[thoth] test: endpoint =", this.client.config.endpoint);
      console.log("[thoth] test: bucket =", this.bucket);
      console.log("[thoth] test: region =", await this.client.config.region());

      const payload = new TextEncoder().encode(`{"test":true,"t":${Date.now()}}`);

      console.log("[thoth] test: writing _thoth/test.json...");
      await this.put("_thoth/test.json", payload.buffer);
      console.log("[thoth] test: write OK");

      console.log("[thoth] test: reading _thoth/test.json...");
      const result = await this.get("_thoth/test.json");
      if (!result) {
        console.error("[thoth] test: read returned null");
        return { ok: false, error: "Write succeeded but read returned null" };
      }
      console.log("[thoth] test: read OK, got", result.byteLength, "bytes");

      console.log("[thoth] test: deleting _thoth/test.json...");
      await this.delete("_thoth/test.json");
      console.log("[thoth] test: delete OK");

      console.log("[thoth] test: all passed ✓");
      return { ok: true };
    } catch (e: any) {
      console.error("[thoth] test: FAILED", e);
      console.error("[thoth] test: error name =", e.name);
      console.error("[thoth] test: error message =", e.message);
      if (e.$metadata) console.error("[thoth] test: metadata =", JSON.stringify(e.$metadata));
      return { ok: false, error: e.name || e.message };
    }
  }
}
