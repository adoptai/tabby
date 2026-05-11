import { Injectable, ConflictException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { IdentityProviderEntity } from '../../entities';
import { AuditService } from '../audit/audit.service';
import { ExternalJwksService } from '../auth/external-jwks.service';
import { OAuthProviderService } from '../auth/oauth-provider.service';

@Injectable()
export class IdentityProvidersService {
  constructor(
    @InjectRepository(IdentityProviderEntity)
    private readonly idpRepo: Repository<IdentityProviderEntity>,
    private readonly auditService: AuditService,
    private readonly jwksService: ExternalJwksService,
    private readonly oauthProvider: OAuthProviderService,
  ) {}

  async create(tenantId: string, data: Partial<IdentityProviderEntity> & { client_secret_plaintext?: string }, actorId: string) {
    // Only one IdP allowed — global, not per-tenant
    const count = await this.idpRepo.count();
    if (count > 0) {
      throw new ConflictException('An identity provider already exists. Only one IdP is supported. Update or delete the existing one first.');
    }

    const toSave = { ...data };
    delete (toSave as any).tenant_id;
    if (data.client_secret_plaintext) {
      toSave.client_secret = this.oauthProvider.encryptSecret(data.client_secret_plaintext);
    }
    delete (toSave as any).client_secret_plaintext;

    const idp = this.idpRepo.create(toSave);
    const saved = await this.idpRepo.save(idp);

    await this.auditService.log({
      tenant_id: tenantId,
      actor_type: 'human',
      actor_id: actorId,
      event_type: 'auth.idp.created',
      payload: { idp_id: saved.id, name: saved.name, provider_type: saved.provider_type },
    });

    return saved;
  }

  async findAll(_tenantId?: string) {
    const idps = await this.idpRepo.find({
      order: { created_at: 'DESC' },
    });
    return idps.map(this.maskSecret);
  }

  async findOne(_tenantId: string, id: string) {
    const idp = await this.idpRepo.findOne({
      where: { id },
    });
    if (!idp) throw new NotFoundException('Identity provider not found');
    return this.maskSecret(idp);
  }

  /** Replace stored encrypted secret with a safe placeholder in API responses. */
  private maskSecret(idp: IdentityProviderEntity): IdentityProviderEntity {
    return { ...idp, client_secret: idp.client_secret ? '***' : null } as IdentityProviderEntity;
  }

  async update(tenantId: string, id: string, data: Partial<IdentityProviderEntity> & { client_secret_plaintext?: string }, actorId: string) {
    const idp = await this.findOne(tenantId, id);
    const toApply: any = { ...data };
    if (data.client_secret_plaintext) {
      toApply.client_secret = this.oauthProvider.encryptSecret(data.client_secret_plaintext);
    }
    delete toApply.client_secret_plaintext;
    Object.assign(idp, toApply);
    const saved = await this.idpRepo.save(idp);

    await this.auditService.log({
      tenant_id: tenantId,
      actor_type: 'human',
      actor_id: actorId,
      event_type: 'auth.idp.updated',
      payload: { idp_id: id },
    });

    return saved;
  }

  async remove(tenantId: string, id: string, actorId: string) {
    const idp = await this.findOne(tenantId, id);
    await this.idpRepo.remove(idp);

    await this.auditService.log({
      tenant_id: tenantId,
      actor_type: 'human',
      actor_id: actorId,
      event_type: 'auth.idp.deleted',
      payload: { idp_id: id, name: idp.name },
    });
  }

  async testJwks(tenantId: string, id: string) {
    const idp = await this.findOne(tenantId, id);
    if (!idp.issuer_url) {
      return { success: false, message: 'No issuer_url configured' };
    }
    try {
      const start = Date.now();
      await this.jwksService.forceRefresh(idp.issuer_url);
      const keys = await this.jwksService['getJwks'](idp.issuer_url);
      return {
        success: true,
        key_count: keys.length,
        latency_ms: Date.now() - start,
        issuer_url: idp.issuer_url,
      };
    } catch (err) {
      return { success: false, message: (err as Error).message };
    }
  }
}
