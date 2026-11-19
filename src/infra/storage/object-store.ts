import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { Env } from '../../config/env.schema';

/** Injection token for the private object store. */
export const OBJECT_STORE = Symbol('OBJECT_STORE');

/**
 * Private file storage (SEC uploads). Objects are never public: the API streams them to people
 * who may see the record that owns them. Keys are random and never derived from file names.
 */
export interface ObjectStore {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

/** Keys are `<owner>/<uuid>` — no dots, so nothing can climb out of the store. */
const KEY = /^[a-z0-9-]+\/[0-9a-f-]{36}$/;

function assertKey(key: string): void {
  if (!KEY.test(key)) throw new RangeError('Invalid storage key');
}

/** S3-compatible store (SeaweedFS in dev, the real bucket in production). */
export class S3ObjectStore implements ObjectStore {
  private readonly client: S3Client;

  constructor(
    private readonly bucket: string,
    options: {
      endpoint?: string | undefined;
      region: string;
      accessKeyId: string;
      secretAccessKey: string;
      forcePathStyle: boolean;
    },
  ) {
    this.client = new S3Client({
      region: options.region,
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
      forcePathStyle: options.forcePathStyle,
      credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
    });
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    assertKey(key);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ContentLength: body.length,
      }),
    );
  }

  async get(key: string): Promise<Buffer> {
    assertKey(key);
    const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!out.Body) throw new Error('Empty object');
    return Buffer.from(await out.Body.transformToByteArray());
  }

  async delete(key: string): Promise<void> {
    assertKey(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

/**
 * Named dev adapter: files in a local folder. Refused in production by the env schema; used by
 * local development and the e2e suite when no S3 store is running.
 */
export class LocalDiskObjectStore implements ObjectStore {
  private readonly root: string;

  constructor(dir: string) {
    this.root = resolve(dir);
  }

  private path(key: string): string {
    assertKey(key);
    const p = resolve(this.root, key);
    if (!p.startsWith(this.root + sep)) throw new RangeError('Invalid storage key');
    return p;
  }

  // Every path below comes from path(): a checked key resolved inside the store's own folder.
  /* eslint-disable security/detect-non-literal-fs-filename */
  async put(key: string, body: Buffer): Promise<void> {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, body, { flag: 'wx' });
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.path(key));
  }
  /* eslint-enable security/detect-non-literal-fs-filename */

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }
}

export function createObjectStore(env: Env): ObjectStore {
  if (env.STORAGE_DRIVER === 'local') return new LocalDiskObjectStore(env.STORAGE_LOCAL_DIR);
  if (!env.S3_BUCKET || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY)
    throw new Error('S3 storage is not configured');
  return new S3ObjectStore(env.S3_BUCKET, {
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
  });
}
