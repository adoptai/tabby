import { Type } from 'class-transformer';
import {
  IsInt,
  Max,
  Min,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class PaginationQueryDto {
  @ApiProperty({ description: 'Number of items per page', example: 50, default: 50, minimum: 1, maximum: 200, required: false })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit = 50;

  @ApiProperty({ description: 'Number of items to skip', example: 0, default: 0, minimum: 0, required: false })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100000)
  offset = 0;
}
