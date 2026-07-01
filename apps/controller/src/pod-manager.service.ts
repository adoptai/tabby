import { Injectable, Logger } from '@nestjs/common';
import { SessionEntity } from './entities/session.entity';
import { ApplicationEntity } from './entities/application.entity';
import * as k8s from '@kubernetes/client-node';
import { createHmac } from 'node:crypto';
import { CDP_PORTS, PORTS, StreamingMode } from '@browser-hitl/shared';

/**
 * Pod Manager Service
 * Manages browser worker pod lifecycle via Kubernetes API.
 * Also manages NetworkPolicies per spec section 13.8.
 */
@Injectable()
export class PodManagerService {
  private readonly logger = new Logger(PodManagerService.name);
  private readonly namespace: string;
  private readonly releaseInstance: string;
  private readonly environment: string;
  private readonly coreApi: k8s.CoreV1Api;
  private readonly networkingApi: k8s.NetworkingV1Api;

  constructor() {
    this.namespace = process.env.WORKER_NAMESPACE || 'browser-hitl';
    this.releaseInstance = (process.env.RELEASE_INSTANCE || '').trim();
    this.environment = (process.env.DEPLOY_ENVIRONMENT || '').trim();
    const kubeConfig = new k8s.KubeConfig();

    if (process.env.KUBERNETES_SERVICE_HOST) {
      kubeConfig.loadFromCluster();
    } else {
      kubeConfig.loadFromDefault();
    }

    this.coreApi = kubeConfig.makeApiClient(k8s.CoreV1Api);
    this.networkingApi = kubeConfig.makeApiClient(k8s.NetworkingV1Api);
  }

  /**
   * Create a browser worker pod for a session.
   * Returns the pod name.
   */
  async createWorkerPod(session: SessionEntity, app: ApplicationEntity): Promise<string> {
    const podName = this.buildPodName(session.id);

    try {
      // Idempotency: if the pod already exists (e.g. two controller replicas raced),
      // log and return the pod name without error.
      const alreadyExists = await this.podExists(podName);
      if (alreadyExists) {
        this.logger.log(`Worker pod ${podName} already exists — reusing for session ${session.id}`);
        return podName;
      }

      const podSpec = this.buildPodSpec(podName, session, app);
      this.logger.log(`Creating worker pod ${podName} for session ${session.id}`);
      await this.createPod(podSpec);
      this.logger.log(`Worker pod ${podName} created`);
      return podName;
    } catch (error: any) {
      // Handle AlreadyExists from Kubernetes API (race between two replicas)
      if (
        error?.response?.statusCode === 409 ||
        String(error?.body || error).includes('AlreadyExists')
      ) {
        this.logger.log(`Worker pod ${podName} already exists (K8s AlreadyExists) — reusing`);
        return podName;
      }
      this.logger.error(`Failed to create pod ${podName}: ${error}`);
      throw error;
    }
  }

  /**
   * Create a per-session ClusterIP service for the noVNC sidecar.
   * Returns the created service name.
   */
  async createNoVncService(sessionId: string, podName: string): Promise<string> {
    const serviceName = this.buildNoVncServiceName(podName);
    try {
      const serviceSpec = this.buildNoVncServiceSpec(serviceName, sessionId);
      this.logger.log(`Creating noVNC service ${serviceName} for session ${sessionId}`);
      await this.createService(serviceSpec);
      this.logger.log(`noVNC service ${serviceName} created`);
      return serviceName;
    } catch (error) {
      this.logger.error(`Failed to create noVNC service ${serviceName}: ${error}`);
      throw error;
    }
  }

  /**
   * Delete the per-session noVNC service.
   */
  async deleteNoVncService(sessionId: string, podName?: string): Promise<void> {
    const serviceName = podName
      ? this.buildNoVncServiceName(podName)
      : this.buildNoVncServiceName(this.buildPodName(sessionId));

    try {
      this.logger.log(`Deleting noVNC service ${serviceName}`);
      await this.deleteService(serviceName);
      this.logger.log(`noVNC service ${serviceName} deleted`);
    } catch (error) {
      this.logger.error(`Failed to delete noVNC service ${serviceName}: ${error}`);
    }
  }

  /**
   * Create a per-session ClusterIP service for the CDP relay.
   * Returns the created service name.
   */
  async createCdpService(sessionId: string, podName: string): Promise<string> {
    const serviceName = this.buildCdpServiceName(podName);
    try {
      const serviceSpec = this.buildCdpServiceSpec(serviceName, sessionId);
      this.logger.log(`Creating CDP service ${serviceName} for session ${sessionId}`);
      await this.createService(serviceSpec);
      this.logger.log(`CDP service ${serviceName} created`);
      return serviceName;
    } catch (error) {
      this.logger.error(`Failed to create CDP service ${serviceName}: ${error}`);
      throw error;
    }
  }

  /**
   * Delete the per-session CDP service.
   */
  async deleteCdpService(sessionId: string, podName?: string): Promise<void> {
    const serviceName = podName
      ? this.buildCdpServiceName(podName)
      : this.buildCdpServiceName(this.buildPodName(sessionId));

    try {
      this.logger.log(`Deleting CDP service ${serviceName}`);
      await this.deleteService(serviceName);
      this.logger.log(`CDP service ${serviceName} deleted`);
    } catch (error) {
      this.logger.error(`Failed to delete CDP service ${serviceName}: ${error}`);
    }
  }

  /**
   * Create a per-session ClusterIP service for the worker health/execute endpoint.
   * Enables API-side execute proxy to reach the worker via K8s DNS.
   */
  async createWorkerService(sessionId: string, podName: string): Promise<string> {
    const serviceName = this.buildWorkerServiceName(podName);
    try {
      const serviceSpec = this.buildWorkerServiceSpec(serviceName, sessionId);
      this.logger.log(`Creating worker service ${serviceName} for session ${sessionId}`);
      await this.createService(serviceSpec);
      this.logger.log(`Worker service ${serviceName} created`);
      return serviceName;
    } catch (error) {
      this.logger.error(`Failed to create worker service ${serviceName}: ${error}`);
      throw error;
    }
  }

  async deleteWorkerService(sessionId: string, podName?: string): Promise<void> {
    const serviceName = podName
      ? this.buildWorkerServiceName(podName)
      : this.buildWorkerServiceName(this.buildPodName(sessionId));

    try {
      this.logger.log(`Deleting worker service ${serviceName}`);
      await this.deleteService(serviceName);
      this.logger.log(`Worker service ${serviceName} deleted`);
    } catch (error) {
      this.logger.error(`Failed to delete worker service ${serviceName}: ${error}`);
    }
  }

  /**
   * Resolve the streaming mode for an app from its browser_policy.
   */
  resolveStreamingMode(app: ApplicationEntity): StreamingMode {
    const policy = app.browser_policy as Record<string, unknown> | null | undefined;
    const raw = typeof policy?.streaming_mode === 'string' ? policy.streaming_mode : '';
    return raw.toLowerCase() === 'cdp' ? StreamingMode.CDP : StreamingMode.VNC;
  }

  /**
   * Delete a browser worker pod.
   */
  async deleteWorkerPod(podName: string): Promise<void> {
    try {
      this.logger.log(`Deleting worker pod ${podName}`);
      await this.deletePod(podName);
      this.logger.log(`Worker pod ${podName} deleted`);
    } catch (error) {
      this.logger.error(`Failed to delete pod ${podName}: ${error}`);
    }
  }

  /**
   * Create a deny-all NetworkPolicy for a worker pod per spec section 13.8.
   * Allow: DNS, internal services, egress proxy.
   */
  async createNetworkPolicy(
    sessionId: string,
    podName: string,
    targetUrls: string[],
    streamingMode: StreamingMode = StreamingMode.VNC,
    executeEnabled: boolean = false,
    extraAllowlist: string[] = [],
    allowAll: boolean = false,
  ): Promise<void> {
    const policyName = this.buildNetworkPolicyName(sessionId);

    try {
      const policy = this.buildNetworkPolicy(policyName, sessionId, streamingMode, executeEnabled);
      this.logger.log(`Creating NetworkPolicy ${policyName} for pod ${podName}`);
      await this.createPolicy(policy);
      await this.syncEgressAllowlist(sessionId, targetUrls, extraAllowlist, allowAll);
      this.logger.log(`NetworkPolicy ${policyName} created`);
    } catch (error) {
      this.logger.error(`Failed to create NetworkPolicy ${policyName}: ${error}`);
      throw error;
    }
  }

  /**
   * Delete a NetworkPolicy when pod is terminated.
   */
  async deleteNetworkPolicy(sessionId: string): Promise<void> {
    const policyName = this.buildNetworkPolicyName(sessionId);

    try {
      this.logger.log(`Deleting NetworkPolicy ${policyName}`);
      await this.deletePolicy(policyName);
      await this.clearEgressAllowlist(sessionId);
      this.logger.log(`NetworkPolicy ${policyName} deleted`);
    } catch (error) {
      this.logger.error(`Failed to delete NetworkPolicy ${policyName}: ${error}`);
    }
  }

  /**
   * Sync session-specific target URLs into the egress proxy allowlist control plane.
   */
  async syncEgressAllowlist(
    sessionId: string,
    targetUrls: string[],
    extraAllowlist: string[] = [],
    allowAll: boolean = false,
  ): Promise<void> {
    const allowlistEndpoint = process.env.EGRESS_PROXY_ALLOWLIST_URL;
    if (!allowlistEndpoint) {
      if (this.egressFailClosed()) {
        throw new Error('EGRESS_PROXY_ALLOWLIST_URL is not configured');
      }
      return;
    }

    const response = await fetch(allowlistEndpoint, {
      method: 'PUT',
      headers: this.buildAllowlistHeaders(),
      body: JSON.stringify({
        session_id: sessionId,
        target_urls: targetUrls,
        extra_allowlist: extraAllowlist,
        allow_all: allowAll,
      }),
    });

    if (!response.ok) {
      const error = new Error(
        `Failed to update egress allowlist (status ${response.status}) for session ${sessionId}`,
      );
      if (this.egressFailClosed()) {
        throw error;
      }
      this.logger.warn(error.message);
    }
  }

  /**
   * Remove session-specific allowlist entries when the session terminates.
   */
  async clearEgressAllowlist(sessionId: string): Promise<void> {
    const allowlistEndpoint = process.env.EGRESS_PROXY_ALLOWLIST_URL;
    if (!allowlistEndpoint) {
      return;
    }

    const normalized = allowlistEndpoint.replace(/\/+$/, '');
    const deleteUrl = `${normalized}/${encodeURIComponent(sessionId)}`;

    try {
      const response = await fetch(deleteUrl, {
        method: 'DELETE',
        headers: this.buildAllowlistHeaders(),
      });

      if (!response.ok) {
        this.logger.warn(
          `Failed to clear egress allowlist (status ${response.status}) for session ${sessionId}`,
        );
      }
    } catch (error) {
      this.logger.warn(`Failed to clear egress allowlist for session ${sessionId}: ${error}`);
    }
  }

  async podExists(podName: string): Promise<boolean> {
    const api: any = this.coreApi as any;
    try {
      try {
        await api.readNamespacedPod(podName, this.namespace);
      } catch {
        await api.readNamespacedPod({ name: podName, namespace: this.namespace });
      }
      return true;
    } catch (error: any) {
      if (this.isNotFoundError(error)) {
        return false;
      }
      throw error;
    }
  }

  async listWorkerPods(): Promise<Array<{ podName: string; sessionId: string | null }>> {
    const api: any = this.coreApi as any;
    const selector = this.releaseInstance
      ? `app=browser-worker,release-instance=${this.releaseInstance}`
      : 'app=browser-worker';
    let result: any;
    try {
      result = await api.listNamespacedPod(this.namespace, undefined, undefined, undefined, undefined, selector);
    } catch {
      result = await api.listNamespacedPod({
        namespace: this.namespace,
        labelSelector: selector,
      });
    }

    const items = Array.isArray(result?.body?.items)
      ? result.body.items
      : Array.isArray(result?.items) ? result.items : [];
    return items.map((item: any) => ({
      podName: String(item?.metadata?.name || ''),
      sessionId: item?.metadata?.labels?.['session-id'] || null,
    })).filter((entry: { podName: string }) => entry.podName.length > 0);
  }

  /**
   * Build pod spec per spec section 15.5.
   * In CDP mode: single container (worker only, headless), no sidecar.
   * In VNC mode: two containers (worker + noVNC sidecar).
   */
  private buildPodSpec(podName: string, session: SessionEntity, app: ApplicationEntity) {
    const streamingMode = this.resolveStreamingMode(app);
    const credentialSecretName = this.resolveCredentialSecretName(app);
    const credentialMountRoot = '/var/run/secrets/browser-hitl';
    const scopedEgressProxyUrl = this.buildSessionScopedProxyUrl(session.id);
    const volumes: Array<Record<string, unknown>> = [{ name: 'tmp', emptyDir: {} }];
    const workerVolumeMounts: Array<Record<string, unknown>> = [{ name: 'tmp', mountPath: '/tmp' }];

    if (credentialSecretName) {
      volumes.push({
        name: 'credentials',
        secret: { secretName: credentialSecretName },
      });
      workerVolumeMounts.push({
        name: 'credentials',
        mountPath: `${credentialMountRoot}/${credentialSecretName}`,
        readOnly: true,
      });
    }

    const workerEnv = [
      { name: 'SESSION_ID', value: session.id },
      { name: 'APP_ID', value: session.app_id },
      { name: 'TENANT_ID', value: session.tenant_id },
      { name: 'CREDENTIALS_MOUNT_PATH', value: credentialMountRoot },
      { name: 'DATABASE_URL', value: process.env.DATABASE_URL },
      { name: 'REDIS_URL', value: process.env.REDIS_URL },
      { name: 'NATS_URL', value: process.env.NATS_URL },
      { name: 'MINIO_ENDPOINT', value: process.env.MINIO_ENDPOINT },
      { name: 'MINIO_ACCESS_KEY', value: process.env.MINIO_ACCESS_KEY || '' },
      { name: 'MINIO_SECRET_KEY', value: process.env.MINIO_SECRET_KEY || '' },
      { name: 'EGRESS_PROXY_URL', value: scopedEgressProxyUrl },
      { name: 'EGRESS_PROXY_BYPASS_LIST', value: process.env.EGRESS_PROXY_BYPASS_LIST },
      { name: 'WORKER_ALLOW_ENV_CREDENTIAL_FALLBACK', value: process.env.WORKER_ALLOW_ENV_CREDENTIAL_FALLBACK },
      { name: 'TENANT_ENCRYPTION_KEY', value: process.env.TENANT_ENCRYPTION_KEY || '' },
      { name: 'TENANT_KEY_VERSION', value: process.env.TENANT_KEY_VERSION || 'v1' },
      { name: 'STREAMING_MODE', value: streamingMode },
      { name: 'EXECUTE_ENABLED', value: String(app.execute_enabled ?? false) },
      ...(app.execute_enabled ? [{ name: 'JWT_SIGNING_KEY', value: process.env.JWT_SIGNING_KEY || '' }] : []),
      { name: 'SENTRY_DSN', value: process.env.SENTRY_DSN || '' },
      { name: 'SENTRY_ENABLED', value: process.env.SENTRY_ENABLED || 'false' },
      { name: 'SENTRY_TRACES_SAMPLE_RATE', value: process.env.SENTRY_TRACES_SAMPLE_RATE || '0.1' },
      { name: 'APP_ENV', value: process.env.APP_ENV || '' },
      { name: 'CHART_VERSION', value: process.env.CHART_VERSION || '' },
      { name: 'EXTRACT_TAB_TIMEOUT_MS', value: process.env.EXTRACT_TAB_TIMEOUT_MS || '' },
      { name: 'EXTRACT_TAB_POLL_INTERVAL_MS', value: process.env.EXTRACT_TAB_POLL_INTERVAL_MS || '' },
      { name: 'NEWRELIC_ENABLED', value: process.env.WORKER_NEWRELIC_ENABLED || process.env.NEWRELIC_ENABLED || 'false' },
      { name: 'NEW_RELIC_LICENSE_KEY', value: process.env.NEW_RELIC_LICENSE_KEY || '' },
      { name: 'NEW_RELIC_APP_NAME', value: process.env.WORKER_NEW_RELIC_APP_NAME || 'Adopt Tabby Worker' },
      { name: 'NEW_RELIC_ENVIRONMENT', value: process.env.NEW_RELIC_ENVIRONMENT || 'production' },
      // Propagate the originating W3C trace context into the worker pod so the
      // browser worker continues the same distributed trace (api -> controller
      // -> worker) rather than starting an isolated one. apps/worker/src/main.ts
      // reads process.env.TRACEPARENT at boot. No-op when the session carries no
      // trace context. Mirrors how OpenSandbox propagates trace context via the
      // BatchSandbox CR annotation + pod env.
      ...(session.traceparent
        ? [{ name: 'TRACEPARENT', value: session.traceparent }]
        : []),
    ];

    // VNC mode needs DISPLAY for Xvfb; CDP mode does not
    if (streamingMode === StreamingMode.VNC) {
      workerEnv.push({ name: 'DISPLAY', value: ':99' });
    }

    const workerPorts: Array<Record<string, unknown>> = [
      { containerPort: 8091, name: 'health' },
    ];

    // CDP mode exposes the relay port
    if (streamingMode === StreamingMode.CDP) {
      workerPorts.push({ containerPort: CDP_PORTS.CDP_RELAY, name: 'cdp-relay' });
    }

    const workerContainer = {
      name: 'worker',
      image: process.env.WORKER_IMAGE || 'browser-hitl/worker:latest',
      ports: workerPorts,
      env: workerEnv,
      resources: {
        requests: {
          cpu: process.env.WORKER_CPU_REQUEST || '500m',
          memory: process.env.WORKER_MEM_REQUEST || '1Gi',
        },
        limits: {
          cpu: process.env.WORKER_CPU_LIMIT || '1500m',
          memory: process.env.WORKER_MEM_LIMIT || '1536Mi',
        },
      },
      livenessProbe: {
        httpGet: { path: '/health', port: 8091 },
        initialDelaySeconds: 30,
        periodSeconds: 10,
      },
      readinessProbe: {
        httpGet: { path: '/health', port: 8091 },
        initialDelaySeconds: 15,
        periodSeconds: 5,
      },
      volumeMounts: workerVolumeMounts,
      securityContext: {
        runAsUser: 1000,
        readOnlyRootFilesystem: false,
      },
    };

    const containers: Array<Record<string, unknown>> = [workerContainer];

    // VNC mode: add noVNC sidecar
    if (streamingMode === StreamingMode.VNC) {
      containers.push({
        name: 'novnc',
        image: process.env.NOVNC_IMAGE || 'browser-hitl/novnc:latest',
        ports: [{ containerPort: 6080, name: 'novnc' }],
        command: ['websockify', '--web', '/usr/share/novnc', '6080', 'localhost:5900'],
        resources: {
          requests: {
            cpu: process.env.NOVNC_CPU_REQUEST || '0.1',
            memory: process.env.NOVNC_MEM_REQUEST || '128Mi',
          },
          limits: {
            cpu: process.env.NOVNC_CPU_LIMIT || '0.5',
            memory: process.env.NOVNC_MEM_LIMIT || '256Mi',
          },
        },
        securityContext: {
          runAsNonRoot: true,
          runAsUser: 65534,
        },
      });
    }

    return {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: {
        name: podName,
        namespace: this.namespace,
        labels: {
          app: 'browser-worker',
          'session-id': session.id,
          'app-id': session.app_id,
          'tenant-id': session.tenant_id,
          'streaming-mode': streamingMode,
          ...(this.releaseInstance ? { 'release-instance': this.releaseInstance } : {}),
          ...(this.environment ? { environment: this.environment } : {}),
        },
      },
      spec: {
        restartPolicy: 'Never',
        securityContext: {
          runAsNonRoot: true,
        },
        containers,
        volumes,
        ...this.parseJsonEnv('WORKER_NODE_SELECTOR', 'nodeSelector'),
        ...this.parseJsonEnv('WORKER_TOLERATIONS', 'tolerations'),
        ...this.parseJsonEnv('WORKER_AFFINITY', 'affinity'),
      },
    };
  }

  private resolveCredentialSecretName(app: ApplicationEntity): string | null {
    const loginConfig = app.login_config as { credential_ref?: unknown } | null | undefined;
    const rawRef = typeof loginConfig?.credential_ref === 'string' ? loginConfig.credential_ref : '';
    const prefix = 'k8s:secret/';
    if (!rawRef.startsWith(prefix)) {
      return null;
    }
    const secretName = rawRef.slice(prefix.length).trim();
    return secretName.length > 0 ? secretName : null;
  }

  private buildSessionScopedProxyUrl(sessionId: string): string {
    const configuredProxyUrl = (process.env.EGRESS_PROXY_URL || '').trim();
    if (!configuredProxyUrl) {
      return '';
    }

    const sessionKey = (process.env.EGRESS_PROXY_SESSION_KEY || '').trim();
    if (!sessionKey) {
      throw new Error(
        'EGRESS_PROXY_SESSION_KEY must be configured when EGRESS_PROXY_URL is enabled',
      );
    }

    let parsed: URL;
    try {
      parsed = new URL(configuredProxyUrl);
    } catch {
      throw new Error(`Invalid EGRESS_PROXY_URL: ${configuredProxyUrl}`);
    }

    const sessionSecret = createHmac('sha256', sessionKey).update(sessionId).digest('hex');
    parsed.username = sessionId;
    parsed.password = sessionSecret;
    parsed.pathname = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  }

  private buildNoVncServiceSpec(serviceName: string, sessionId: string) {
    return {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name: serviceName,
        namespace: this.namespace,
        labels: {
          app: 'browser-worker-novnc',
          'session-id': sessionId,
        },
      },
      spec: {
        type: 'ClusterIP',
        selector: {
          'session-id': sessionId,
        },
        ports: [
          {
            name: 'novnc',
            port: 6080,
            targetPort: 'novnc',
            protocol: 'TCP',
          },
        ],
      },
    };
  }

  /**
   * Build NetworkPolicy per spec section 13.8.
   * Deny-all egress except DNS, internal services, egress proxy.
   * Supports both VNC (port 6080) and CDP (port 9223) ingress from API.
   */
  private buildNetworkPolicy(policyName: string, sessionId: string, streamingMode: StreamingMode = StreamingMode.VNC, executeEnabled: boolean = false) {
    const streamPort = streamingMode === StreamingMode.CDP ? CDP_PORTS.CDP_RELAY : 6080;
    return {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: {
        name: policyName,
        namespace: this.namespace,
      },
      spec: {
        podSelector: {
          matchLabels: { 'session-id': sessionId },
        },
        policyTypes: ['Ingress', 'Egress'],
        egress: [
          // Allow DNS
          {
            ports: [
              { port: 53, protocol: 'UDP' },
              { port: 53, protocol: 'TCP' },
            ],
          },
          // Allow egress proxy
          {
            to: [{
              podSelector: { matchLabels: { 'app.kubernetes.io/component': 'egress-proxy' } },
            }],
          },
          // Allow internal services (explicit component selectors only).
          {
            to: [{
              namespaceSelector: {
                matchLabels: { 'kubernetes.io/metadata.name': this.namespace },
              },
              podSelector: {
                matchExpressions: [
                  {
                    key: 'app.kubernetes.io/component',
                    operator: 'In',
                    values: ['postgres', 'redis', 'nats', 'minio', 'api'],
                  },
                ],
              },
            }],
            ports: [
              { port: 5432 },  // Postgres
              { port: 6379 },  // Redis
              { port: 4222 },  // NATS
              { port: 9000 },  // MinIO
            ],
          },
          // Allow test harness endpoint used in UAT flows.
          {
            to: [{
              namespaceSelector: {
                matchLabels: { 'kubernetes.io/metadata.name': this.namespace },
              },
              podSelector: {
                matchExpressions: [
                  { key: 'app', operator: 'In', values: ['test-harness', 'browser-hitl-test-harness'] },
                ],
              },
            }],
            ports: [{ port: 8000 }],
          },
        ],
        ingress: [
          {
            from: [{
              podSelector: { matchLabels: { 'app.kubernetes.io/component': 'api' } },
            }],
            ports: [
              { port: streamPort, protocol: 'TCP' },
              ...(executeEnabled ? [{ port: PORTS.WORKER_HEALTH, protocol: 'TCP' }] : []),
            ],
          },
          // Allow NGINX ingress to stream port
          {
            from: [{
              namespaceSelector: {},
              podSelector: { matchLabels: { 'app.kubernetes.io/name': 'ingress-nginx' } },
            }],
            ports: [{ port: streamPort, protocol: 'TCP' }],
          },
          // Allow kubelet probes to health port
          {
            ports: [{ port: 8091, protocol: 'TCP' }],
          },
        ],
      },
    };
  }

  private buildPodName(sessionId: string): string {
    return `worker-${sessionId.toLowerCase()}`;
  }

  private buildNoVncServiceName(podName: string): string {
    return `${podName}-novnc`;
  }

  private buildCdpServiceName(podName: string): string {
    return `${podName}-cdp`;
  }

  private buildWorkerServiceName(podName: string): string {
    return `${podName}-worker`;
  }

  private buildCdpServiceSpec(serviceName: string, sessionId: string) {
    return {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name: serviceName,
        namespace: this.namespace,
        labels: {
          app: 'browser-worker-cdp',
          'session-id': sessionId,
        },
      },
      spec: {
        type: 'ClusterIP',
        selector: {
          'session-id': sessionId,
        },
        ports: [
          {
            name: 'cdp-relay',
            port: CDP_PORTS.CDP_RELAY,
            targetPort: 'cdp-relay',
            protocol: 'TCP',
          },
        ],
      },
    };
  }

  private buildWorkerServiceSpec(serviceName: string, sessionId: string) {
    return {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name: serviceName,
        namespace: this.namespace,
        labels: {
          app: 'browser-worker-execute',
          'session-id': sessionId,
        },
      },
      spec: {
        type: 'ClusterIP',
        selector: {
          'session-id': sessionId,
        },
        ports: [
          {
            name: 'worker-health',
            port: PORTS.WORKER_HEALTH,
            targetPort: PORTS.WORKER_HEALTH,
            protocol: 'TCP',
          },
        ],
      },
    };
  }

  private buildNetworkPolicyName(sessionId: string): string {
    return `np-${sessionId.toLowerCase()}`;
  }

  private async createPod(podSpec: unknown): Promise<void> {
    const api: any = this.coreApi as any;
    try {
      await api.createNamespacedPod(this.namespace, podSpec);
    } catch {
      await api.createNamespacedPod({ namespace: this.namespace, body: podSpec });
    }
  }

  private async deletePod(podName: string): Promise<void> {
    const api: any = this.coreApi as any;
    try {
      await api.deleteNamespacedPod(podName, this.namespace);
    } catch (error: any) {
      if (this.isNotFoundError(error)) {
        return;
      }
      try {
        await api.deleteNamespacedPod({ name: podName, namespace: this.namespace });
      } catch (error2: any) {
        if (!this.isNotFoundError(error2)) {
          throw error2;
        }
      }
    }
  }

  private async createPolicy(policySpec: unknown): Promise<void> {
    const api: any = this.networkingApi as any;
    try {
      await api.createNamespacedNetworkPolicy(this.namespace, policySpec);
    } catch {
      await api.createNamespacedNetworkPolicy({ namespace: this.namespace, body: policySpec });
    }
  }

  private async createService(serviceSpec: unknown): Promise<void> {
    const api: any = this.coreApi as any;
    try {
      await api.createNamespacedService(this.namespace, serviceSpec);
    } catch {
      await api.createNamespacedService({ namespace: this.namespace, body: serviceSpec });
    }
  }

  private async deletePolicy(policyName: string): Promise<void> {
    const api: any = this.networkingApi as any;
    try {
      await api.deleteNamespacedNetworkPolicy(policyName, this.namespace);
    } catch (error: any) {
      if (this.isNotFoundError(error)) {
        return;
      }
      try {
        await api.deleteNamespacedNetworkPolicy({ name: policyName, namespace: this.namespace });
      } catch (error2: any) {
        if (!this.isNotFoundError(error2)) {
          throw error2;
        }
      }
    }
  }

  private async deleteService(serviceName: string): Promise<void> {
    const api: any = this.coreApi as any;
    try {
      await api.deleteNamespacedService(serviceName, this.namespace);
    } catch (error: any) {
      if (this.isNotFoundError(error)) {
        return;
      }
      try {
        await api.deleteNamespacedService({ name: serviceName, namespace: this.namespace });
      } catch (error2: any) {
        if (!this.isNotFoundError(error2)) {
          throw error2;
        }
      }
    }
  }

  private isNotFoundError(error: any): boolean {
    const candidates = [
      error?.response?.statusCode,
      error?.statusCode,
      error?.code,
      error?.body?.code,
      error?.response?.body?.code,
    ];
    if (candidates.some((value) => Number(value) === 404)) {
      return true;
    }

    const bodyText = typeof error?.body === 'string' ? error.body : '';
    const responseBodyText = typeof error?.response?.body === 'string' ? error.response.body : '';
    const messageText = String(error?.message || '');
    const combined = `${messageText} ${bodyText} ${responseBodyText}`.toLowerCase();

    return combined.includes('notfound')
      || combined.includes('not found')
      || combined.includes('"code":404');
  }

  private buildAllowlistHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    const token = process.env.EGRESS_PROXY_ALLOWLIST_TOKEN;
    if (token) {
      headers['x-egress-admin-token'] = token;
    }
    return headers;
  }

  private egressFailClosed(): boolean {
    return (process.env.EGRESS_POLICY_FAIL_CLOSED || 'true').trim().toLowerCase() !== 'false';
  }

  /**
   * Parse a JSON env var and return { key: value } or {} on missing/invalid input.
   * Logs a warning if the env var is set but not valid JSON.
   */
  private parseJsonEnv(envVar: string, key: string): Record<string, unknown> {
    const raw = process.env[envVar];
    if (!raw) {
      return {};
    }
    try {
      return { [key]: JSON.parse(raw) };
    } catch {
      this.logger.warn(`Invalid JSON in ${envVar} — skipping ${key}: ${raw}`);
      return {};
    }
  }
}
