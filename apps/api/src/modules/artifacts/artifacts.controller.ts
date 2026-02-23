import {
  Controller, Get, Param, Query, Req, Res, UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard, RolesGuard, Roles } from '../../common/guards/roles.guard';
import { ArtifactsService } from './artifacts.service';
import { Response } from 'express';

@ApiTags('Artifacts')
@Controller('artifacts')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ArtifactsController {
  constructor(private readonly artifactsService: ArtifactsService) {}

  @Get(':id')
  @Roles('Admin', 'Operator')
  async getPresignedUrl(@Param('id') id: string, @Req() req: any) {
    return this.artifactsService.getPresignedUrl(
      id,
      req.user.tenant_id,
      req.user.user_id,
    );
  }

  @Get(':id/download')
  @Roles('Admin', 'Operator')
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
