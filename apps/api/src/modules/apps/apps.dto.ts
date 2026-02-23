import {
  IsString, IsArray, IsObject, IsOptional, IsInt, Min, MinLength, ArrayMinSize,
} from 'class-validator';

export class CreateAppDto {
  @IsString()
  @MinLength(1)
  name: string;

  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  target_urls: string[];

  @IsObject()
  login_config: Record<string, unknown>;

  @IsObject()
  keepalive_config: Record<string, unknown>;

  @IsObject()
  export_policy: Record<string, unknown>;

  @IsObject()
  notification_config: Record<string, unknown>;

  @IsOptional()
  @IsInt()
  @Min(0)
  desired_session_count?: number;

  @IsOptional()
  @IsObject()
  browser_policy?: Record<string, unknown>;
}

export class UpdateAppDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  target_urls?: string[];

  @IsOptional()
  @IsObject()
  login_config?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  keepalive_config?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  export_policy?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  notification_config?: Record<string, unknown>;

  @IsOptional()
  @IsInt()
  @Min(0)
  desired_session_count?: number;

  @IsOptional()
  @IsObject()
  browser_policy?: Record<string, unknown>;
}
