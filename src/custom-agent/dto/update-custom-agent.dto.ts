import { PartialType } from '@nestjs/mapped-types';
import { CreateCustomAgentDto } from './create-custom-agent.dto';

export class UpdateCustomAgentDto extends PartialType(CreateCustomAgentDto) {}
