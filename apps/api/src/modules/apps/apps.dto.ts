import {
  IsString, IsArray, IsObject, IsOptional, IsInt, Min, MinLength, ArrayMinSize,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';

export const APP_SELECTABLE_FIELDS = [
  'id', 'name', 'tenant_id', 'target_urls', 'login_config', 'keepalive_config',
  'export_policy', 'notification_config', 'browser_policy', 'desired_session_count',
  'credential_last_validated_at', 'credential_rotation_reminder_days',
  'created_at', 'updated_at',
] as const;

export type AppSelectableField = typeof APP_SELECTABLE_FIELDS[number];

export class ListAppsQueryDto {
  @ApiProperty({ description: 'Number of items per page', example: 50, default: 50, minimum: 1, maximum: 200, required: false })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit = 50;

  @ApiProperty({ description: 'Number of items to skip', example: 0, default: 0, minimum: 0, required: false })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset = 0;

  @ApiProperty({
    description: `Comma-separated list of fields to include in each result. Omit to return all fields. Allowed: ${APP_SELECTABLE_FIELDS.join(', ')}`,
    example: 'id,name,desired_session_count',
    required: false,
  })
  @IsOptional()
  @IsString()
  fields?: string;
}

export class CreateAppDto {
  @ApiProperty({ description: 'Application display name', example: 'HubSpot Production' })
  @IsString()
  @MinLength(1)
  name: string;

  @ApiProperty({ description: 'URLs the worker browser is allowed to access (egress allowlist)', example: ['https://app.hubspot.com', 'https://api.hubapi.com'] })
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  target_urls: string[];

  @ApiProperty({ description: 'Login DSL configuration with URL, credential ref, and steps', example: { login_url: 'https://app.hubspot.com/login', credential_ref: 'k8s:secret/hubspot-creds', steps: [{ action: 'goto', url: 'https://app.hubspot.com/login' }, { action: 'fill', selector: '#username', value: '${USERNAME}' }, { action: 'click', selector: '#loginBtn' }] } })
  @IsObject()
  login_config: Record<string, unknown>;

  @ApiProperty({ description: 'Health check configuration', example: { interval_seconds: 300, actions: [{ action: 'goto', url: 'https://app.hubspot.com/home' }], health_checks: [{ type: 'url_check', url: 'https://app.hubspot.com/home', expect_status: 200 }], policy: 'all' } })
  @IsObject()
  keepalive_config: Record<string, unknown>;

  @ApiProperty({ description: 'Credential export configuration', example: { artifact_types: ['cookies', 'headers', 'csrf_token'], encryption: { algo: 'AES-256-GCM', key_ref: 'k8s:secret/tenant-key' }, ttl_seconds: 3600 } })
  @IsObject()
  export_policy: Record<string, unknown>;

  @ApiProperty({ description: 'Notification channels for HITL events', example: { channels: ['slack:#tabby-experiments'] } })
  @IsObject()
  notification_config: Record<string, unknown>;

  @ApiProperty({ description: 'Number of worker sessions to maintain', example: 1, required: false, default: 1 })
  @IsOptional()
  @IsInt()
  @Min(0)
  desired_session_count?: number;

  @ApiProperty({ description: 'Browser security policy', example: { downloads: false, clipboard: false, file_chooser: false }, required: false })
  @IsOptional()
  @IsObject()
  browser_policy?: Record<string, unknown>;
}

export class UpdateAppDto {
  @ApiProperty({ description: 'Application display name', example: 'HubSpot Production', required: false })
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @ApiProperty({ description: 'URLs the worker browser is allowed to access (egress allowlist)', example: ['https://app.hubspot.com', 'https://api.hubapi.com'], required: false })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  target_urls?: string[];

  @ApiProperty({ description: 'Login DSL configuration with URL, credential ref, and steps', example: { login_url: 'https://app.hubspot.com/login', credential_ref: 'k8s:secret/hubspot-creds', steps: [{ action: 'goto', url: 'https://app.hubspot.com/login' }, { action: 'fill', selector: '#username', value: '${USERNAME}' }, { action: 'click', selector: '#loginBtn' }] }, required: false })
  @IsOptional()
  @IsObject()
  login_config?: Record<string, unknown>;

  @ApiProperty({ description: 'Health check configuration', example: { interval_seconds: 300, actions: [{ action: 'goto', url: 'https://app.hubspot.com/home' }], health_checks: [{ type: 'url_check', url: 'https://app.hubspot.com/home', expect_status: 200 }], policy: 'all' }, required: false })
  @IsOptional()
  @IsObject()
  keepalive_config?: Record<string, unknown>;

  @ApiProperty({ description: 'Credential export configuration', example: { artifact_types: ['cookies', 'headers', 'csrf_token'], encryption: { algo: 'AES-256-GCM', key_ref: 'k8s:secret/tenant-key' }, ttl_seconds: 3600 }, required: false })
  @IsOptional()
  @IsObject()
  export_policy?: Record<string, unknown>;

  @ApiProperty({ description: 'Notification channels for HITL events', example: { channels: ['slack:#tabby-experiments'] }, required: false })
  @IsOptional()
  @IsObject()
  notification_config?: Record<string, unknown>;

  @ApiProperty({ description: 'Number of worker sessions to maintain', example: 1, required: false, default: 1 })
  @IsOptional()
  @IsInt()
  @Min(0)
  desired_session_count?: number;

  @ApiProperty({ description: 'Browser security policy', example: { downloads: false, clipboard: false, file_chooser: false }, required: false })
  @IsOptional()
  @IsObject()
  browser_policy?: Record<string, unknown>;
}
