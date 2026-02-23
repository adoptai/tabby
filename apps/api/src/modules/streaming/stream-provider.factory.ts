import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BrowserStreamProvider } from '@browser-hitl/shared';
import { SessionEntity, ApplicationEntity } from '../../entities';
import { VncStreamProvider } from './vnc-stream.provider';
import { CdpStreamProvider } from './cdp-stream.provider';

/**
 * Mode-aware provider resolution.
 * Reads `browser_policy.streaming_mode` from the application config
 * and returns the appropriate BrowserStreamProvider implementation.
 */
@Injectable()
export class StreamProviderFactory {
  private readonly logger = new Logger(StreamProviderFactory.name);

  constructor(
    private readonly vncProvider: VncStreamProvider,
    private readonly cdpProvider: CdpStreamProvider,
    @InjectRepository(SessionEntity)
    private readonly sessionRepo: Repository<SessionEntity>,
    @InjectRepository(ApplicationEntity)
    private readonly appRepo: Repository<ApplicationEntity>,
  ) {}

  async resolve(sessionId: string): Promise<BrowserStreamProvider> {
    const session = await this.sessionRepo.findOne({ where: { id: sessionId } });
    if (!session) {
      throw new NotFoundException('Session not found');
    }

    const app = await this.appRepo.findOne({ where: { id: session.app_id } });
    if (!app) {
      throw new NotFoundException('Application not found');
    }

    const policy = app.browser_policy as Record<string, unknown> | null | undefined;
    const mode = typeof policy?.streaming_mode === 'string'
      ? policy.streaming_mode.toLowerCase()
      : 'vnc';

    if (mode === 'cdp') {
      this.logger.debug(`Resolved CDP provider for session ${sessionId}`);
      return this.cdpProvider;
    }

    this.logger.debug(`Resolved VNC provider for session ${sessionId}`);
    return this.vncProvider;
  }
}
