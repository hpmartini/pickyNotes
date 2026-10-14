import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { AwsClient } from "aws4fetch";

/** Large attachments live here instead of the vault; the note keeps a link plus the extracted text. */
export interface ObjectStore {
  /** Upper bound for a single attachment. */
  readonly maxBytes: number;
  put(key: string, bytes: Buffer, mime: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  /** Streams the object to a temp file (for `claude -p` to read); call `cleanup` when done. */
  download(key: string): Promise<{ path: string; cleanup: () => Promise<void> }>;
  /** Stable reference stored in the note. */
  link(key: string): string;
}

export interface S3Options {
  endpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  region: string;
  maxAttachmentBytes: number;
}

/** S3-compatible store (path-style URLs, SigV4 via aws4fetch). Works with RustFS, Garage, MinIO, AWS. */
export class S3ObjectStore implements ObjectStore {
  readonly maxBytes: number;
  private aws: AwsClient;
  private bucketReady?: Promise<void>;
  constructor(private o: S3Options, private f: typeof fetch = fetch) {
    this.maxBytes = o.maxAttachmentBytes;
    this.aws = new AwsClient({ accessKeyId: o.accessKey, secretAccessKey: o.secretKey, region: o.region, service: "s3" });
  }

  private url(key = "") {
    return `${this.o.endpoint.replace(/\/$/, "")}/${this.o.bucket}${key ? "/" + key.split("/").map(encodeURIComponent).join("/") : ""}`;
  }
  private async send(method: string, url: string, init: { body?: Buffer; headers?: Record<string, string> } = {}) {
    // Buffer is a Uint8Array: valid fetch body, but not in the DOM BodyInit typing
    return this.f(await this.aws.sign(url, { method, body: init.body as unknown as BodyInit, headers: init.headers }));
  }
  /** Creates the bucket on first use (idempotent), so the store may start after the server. A failed attempt is retried by the next call. */
  private ensureBucket() {
    this.bucketReady ??= (async () => {
      const res = await this.send("PUT", this.url());
      if (!res.ok && res.status !== 409) throw new Error(`s3 create bucket -> ${res.status}`); // 409 = already exists
    })().catch((e) => {
      this.bucketReady = undefined;
      throw e;
    });
    return this.bucketReady;
  }

  async put(key: string, bytes: Buffer, mime: string) {
    await this.ensureBucket();
    const res = await this.send("PUT", this.url(key), { body: bytes, headers: { "content-type": mime } });
    if (!res.ok) throw new Error(`s3 put ${key} -> ${res.status}`);
  }
  async get(key: string) {
    const res = await this.send("GET", this.url(key));
    if (!res.ok) throw new Error(`s3 get ${key} -> ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  async download(key: string) {
    const res = await this.send("GET", this.url(key));
    if (!res.ok || !res.body) throw new Error(`s3 get ${key} -> ${res.status}`);
    const dir = await mkdtemp(path.join(tmpdir(), "picky-s3-"));
    const file = path.join(dir, path.basename(key));
    const cleanup = () => rm(dir, { recursive: true, force: true });
    try {
      await pipeline(Readable.fromWeb(res.body as never), createWriteStream(file));
    } catch (e) {
      await cleanup();
      throw e;
    }
    return { path: file, cleanup };
  }
  link(key: string) {
    return `s3://${this.o.bucket}/${key}`;
  }
}
