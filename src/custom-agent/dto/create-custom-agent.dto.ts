import { IsString, IsNumber, IsBoolean, IsOptional } from 'class-validator';

export class CreateCustomAgentDto {
  @IsString()
  name: string;

  @IsString()
  systemPrompt: string;

  @IsNumber()
  organizationId: number;

  @IsString()
  @IsOptional()
  mode?: "CHAT" | "FILE" | "IMAGE" | "VIDEO";

  @IsNumber()
  @IsOptional()
  modelId?: number;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}
