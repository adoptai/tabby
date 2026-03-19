import {
  Controller, Get, Param, Query, Req, Res, UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse, ApiParam, ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard, RolesGuard, Roles } from '../../common/guards/roles.guard';
import { ArtifactsService } from './artifacts.service';
import { Response } from 'express';

@ApiTags('Artifacts')
@ApiBearerAuth()
@Controller('artifacts')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ArtifactsController {
  constructor(private readonly artifactsService: ArtifactsService) {}

  @Get(':id')
  @Roles('Admin', 'Operator')
  @ApiOperation({ summary: 'Get artifact access URL', description: 'Returns a single-use download URL and token for an encrypted artifact bundle.' })
  @ApiParam({ name: 'id', description: 'Artifact bundle UUID' })
  @ApiResponse({ status: 200, description: 'Access link issued', schema: { example: { presigned_url: 'https://...', download_url: '/artifacts/.../download?token_id=...', token_id: 'tok-uuid', expires_at: '2026-03-18T10:12:00.000Z' } } })
  async getPresignedUrl(@Param('id') id: string, @Req() req: any) {
    return this.artifactsService.getPresignedUrl(
      id,
      req.user.tenant_id,
      req.user.user_id,
    );
  }

  @Get(':id/download')
  @Roles('Admin', 'Operator')
  @ApiOperation({ summary: 'Download artifact', description: 'Streams the encrypted artifact bundle. Requires a single-use token_id from the access link endpoint.' })
  @ApiParam({ name: 'id', description: 'Artifact bundle UUID' })
  @ApiQuery({ name: 'token_id', description: 'Single-use download token', required: true })
  @ApiResponse({ status: 200, description: 'Encrypted artifact stream (application/octet-stream)' })
  @ApiResponse({ status: 401, description: 'Invalid or expired token' })
  async downloadArtifact(
    @Param('id') id: string,
    @Query('token_id') tokenId: string,
    @Req() req: any,
    @Res() res: Response,
  ) {
    const { stream, filename } = await this.artifactsService.downloadArtifact(
      id,
      tokenId,
      req.user.tenant_id,
      req.user.user_id,
    );

    res.setHeader('content-type', 'application/octet-stream');
    res.setHeader('content-disposition', `attachment; filename="${filename}"`);
    res.setHeader('cache-control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('pragma', 'no-cache');
    res.setHeader('x-content-type-options', 'nosniff');
    stream.pipe(res);
  }
}
