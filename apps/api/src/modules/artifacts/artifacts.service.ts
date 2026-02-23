import {
  Injectable, NotFoundException, ForbiddenException, BadRequestException, UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ArtifactBundleEntity, ArtifactConsumptionEntity } from '../../entities';
import { AuditService } from '../audit/audit.service';
import { ArtifactTokenService } from './artifact-token.service';
import { MinioProvisionerService } from '../tenants/minio-provisioner.service';
import { Readable } from 'stream';
import * as Minio from 'minio';

@Injectable()
export class ArtifactsService {
  private readonly minioClient: Minio.Client;

  constructor(
    @InjectRepository(ArtifactBundleEntity)
    private readonly artifactRepo: Repository<ArtifactBundleEntity>,
    @InjectRepository(ArtifactConsumptionEntity)
    private readonly consumptionRepo: Repository<ArtifactConsumptionEntity>,
    private readonly auditService: AuditService,
    private readonly artifactTokenService: ArtifactTokenService,
    private readonly minioProvisioner: MinioProvisionerService,
  ) {
    this.minioClient = this.minioProvisioner.getClient();
  }

  async getPresignedUrl(
    artifactId: string,
    tenantId: string,
    actorId: string,
  ): Promise<{
    presigned_url: string;
    download_url: string;
    token_id: string;
    expires_at: string;
  }> {
    await this.findTenantArtifactOrThrow(artifactId, tenantId);

    // Issue a single-use token; retrieval path enforces consume-on-download.
    const { token_id, expires_at } = await this.artifactTokenService.issueArtifactToken();
    const downloadUrl = this.buildDownloadUrl(artifactId, token_id);

    // Compatibility: keep presigned_url key in API contract, but point to API download route.
    await this.auditService.log({
      tenant_id: tenantId,
      actor_type: 'human',
      actor_id: actorId,
      event_type: 'artifact.access_link_issued',
      payload: { artifact_id: artifactId, token_id },
    });

    return {
      presigned_url: downloadUrl,
      download_url: downloadUrl,
      token_id,
      expires_at,
    };
  }

  async downloadArtifact(
    artifactId: string,
    tokenId: string,
    tenantId: string,
    actorId: string,
  ): Promise<{ stream: Readable; filename: string }> {
    const normalizedTokenId = (tokenId || '').trim();
    if (!normalizedTokenId) {
      throw new BadRequestException('token_id query parameter is required');
    }

    const artifact = await this.findTenantArtifactOrThrow(artifactId, tenantId);
    const tokenValidation = await this.artifactTokenService.validateArtifactToken(normalizedTokenId);
    if (!tokenValidation.valid) {
      throw new UnauthorizedException(tokenValidation.reason);
    }

    const bucket = this.minioProvisioner.bucketName(tenantId);
    const objectKey = artifact.encrypted_payload_ref;
    const stream = await this.minioClient.getObject(bucket, objectKey);

    const consumption = this.consumptionRepo.create({
      artifact_id: artifactId,
      consumer_id: actorId,
      token_id: normalizedTokenId,
      access_method: 'presigned_url',
    });
    await this.consumptionRepo.save(consumption);

    await this.auditService.log({
      tenant_id: tenantId,
      actor_type: 'human',
      actor_id: actorId,
      event_type: 'artifact.accessed',
      payload: { artifact_id: artifactId, token_id: normalizedTokenId },
    });

    const filename = `${artifact.id}.enc`;
    return { stream: stream as Readable, filename };
  }

  private async findTenantArtifactOrThrow(
    artifactId: string,
    tenantId: string,
  ): Promise<ArtifactBundleEntity> {
    const artifact = await this.artifactRepo.findOne({ where: { id: artifactId } });
    if (!artifact) {
      throw new NotFoundException('Artifact not found');
    }
    if (artifact.tenant_id !== tenantId) {
      throw new ForbiddenException('Artifact does not belong to your tenant');
    }
    if (new Date() > artifact.expires_at) {
      throw new NotFoundException('Artifact has expired');
    }
    return artifact;
  }

  private buildDownloadUrl(artifactId: string, tokenId: string): string {
    const path = `/artifacts/${encodeURIComponent(artifactId)}/download?token_id=${encodeURIComponent(tokenId)}`;
    const externalBase = (process.env.PUBLIC_BASE_URL || process.env.EXTERNAL_BASE_URL || '').trim();
    if (!externalBase) {
      return path;
    }

    try {
      const base = new URL(externalBase);
      const normalizedPath = path.startsWith('/') ? path : `/${path}`;
      return `${base.protocol}//${base.host}${normalizedPath}`;
    } catch {
      return path;
    }
  }
}
