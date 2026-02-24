import { PartialType } from '@nestjs/mapped-types';
import { CreateIaModelDto } from './create-ia-model.dto';

export class UpdateIaModelDto extends PartialType(CreateIaModelDto) {}
