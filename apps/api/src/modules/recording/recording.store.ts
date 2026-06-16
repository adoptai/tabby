import { Injectable, Logger } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import type { Readable } from 'stream';
import { PORTS, requireEnv, type RecordingBundle } from '@browser-hitl/shared';
import { MinioProvisionerService } from '../tenants/minio-provisioner.service';

/**
 * Persists VNC recording bundles and drains them from worker pods.
 *
 * Bundles contain HAR with potentially sensitive request bodies, so they are
 * stored AES-256-GCM encrypted in MinIO using the tenant encryption key, in
 * the self-describing blob format the worker already uses for artifacts:
 * [nonce(12)][ciphertext][authTag(16)]. No separate DB pointer is needed —
 * the object key is derived from the session id.
 */
@Injectable()
export class RecordingStore {
  private readonly logger = new Logger(RecordingStore.name);
  private readonly workerNamespace: string;
  private readonly localWorkerUrl: string | undefined;

  constructor(private readonly minio: MinioProvisionerService) {
    this.workerNamespace = process.env.WORKER_NAMESPACE || 'browser-hitl';
    this.localWorkerUrl = process.env.LOCAL_WORKER_URL;
  }

  private buildWorkerUrl(podName: string, path: string): string {
    if (this.localWorkerUrl) {
      return `${this.localWorkerUrl.replace(/\/+$/, '')}${path}`;
    }
    return `http://${podName}-worker.${this.workerNamespace}.svc.cluster.local:${PORTS.WORKER_HEALTH}${path}`;
  }

  /** Drain the recording bundle from the worker pod (synchronous flush). */
  async drainFromWorker(podName: string, sessionId: string): Promise<RecordingBundle> {
    const url = this.buildWorkerUrl(podName, '/recording/stop');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 65_000);
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId }),
        signal: controller.signal,
      });
      const json = (await resp.json()) as { success?: boolean; bundle?: RecordingBundle; error?: string };
      if (!resp.ok || !json.success || !json.bundle) {
        throw new Error(json.error || `Worker recording drain failed (HTTP ${resp.status})`);
      }
      return json.bundle;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Encrypt + store a bundle. Returns the object key. */
  async persist(tenantId: string, sessionId: string, bundle: RecordingBundle): Promise<string> {
    await this.minio.provisionBucket(tenantId);
    const bucket = this.minio.bucketName(tenantId);
    const objectKey = this.objectKey(sessionId);
    const blob = this.encrypt(Buffer.from(JSON.stringify(bundle), 'utf8'));
    await this.minio.getClient().putObject(bucket, objectKey, blob, blob.length, {
      'Content-Type': 'application/octet-stream',
    });
    this.logger.log(`Persisted recording bundle for session ${sessionId} (${blob.length} bytes encrypted)`);
    return objectKey;
  }

  /** Fetch + decrypt a bundle. Returns null if none exists. */
  async retrieve(tenantId: string, sessionId: string): Promise<RecordingBundle | null> {
    const bucket = this.minio.bucketName(tenantId);
    const objectKey = this.objectKey(sessionId);
    let blob: Buffer;
    try {
      const stream = await this.minio.getClient().getObject(bucket, objectKey);
      blob = await this.streamToBuffer(stream as Readable);
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === 'NoSuchKey' || code === 'NotFound' || code === 'NoSuchBucket') return null;
      throw err;
    }
    return JSON.parse(this.decrypt(blob).toString('utf8')) as RecordingBundle;
  }

  private objectKey(sessionId: string): string {
    return `recordings/${sessionId}.json.enc`;
  }

  private encryptionKey(): Buffer {
    return Buffer.from(requireEnv('TENANT_ENCRYPTION_KEY', { testDefault: '0'.repeat(64) }), 'hex');
  }

  private encrypt(plaintext: Buffer): Buffer {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey(), nonce);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return Buffer.concat([nonce, ciphertext, authTag]);
  }

  private decrypt(blob: Buffer): Buffer {
    const nonceLength = 12;
    const authTagLength = 16;
    if (blob.length < nonceLength + authTagLength) {
      throw new Error('Encrypted recording payload too short');
    }
    const nonce = blob.subarray(0, nonceLength);
    const authTag = blob.subarray(blob.length - authTagLength);
    const ciphertext = blob.subarray(nonceLength, blob.length - authTagLength);
    const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey(), nonce);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }

  private async streamToBuffer(stream: Readable): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
}
