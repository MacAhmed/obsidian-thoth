import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import type { StorageBackend } from "../storage";

interface S3Error {
  name: string;
  message: string;
  $metadata?: { httpStatusCode?: number };
}

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

  async putConditional(key: string, data: ArrayBuffer, ifMatch: string): Promise<boolean> {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: new Uint8Array(data),
          IfMatch: ifMatch,
        })
      );
      return true;
    } catch (e: unknown) {
      const err = e as S3Error;
      if (err.name === "PreconditionFailed" || err.$metadata?.httpStatusCode === 412) {
        return false;
      }
      throw e;
    }
  }

  async getWithEtag(key: string): Promise<{ data: ArrayBuffer; etag: string } | null> {
    try {
      const res = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
          ResponseCacheControl: "no-store",
        })
      );
      const bytes = await res.Body?.transformToByteArray();
      if (!bytes) return null;
      const etag = res.ETag || "";
      return { data: bytes.buffer as ArrayBuffer, etag };
    } catch (e: unknown) {
      const err = e as S3Error;
      if (err.name === "NoSuchKey" || err.$metadata?.httpStatusCode === 404) {
        return null;
      }
      throw e;
    }
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
    } catch (e: unknown) {
      const err = e as S3Error;
      if (err.name === "NoSuchKey" || err.$metadata?.httpStatusCode === 404) {
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

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const res = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: token,
        })
      );
      for (const obj of res.Contents || []) {
        if (obj.Key) keys.push(obj.Key);
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return keys;
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
    } catch (e: unknown) {
      const err = e as S3Error;
      return { ok: false, error: err.name || err.message };
    }
  }
}
