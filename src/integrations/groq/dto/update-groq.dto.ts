import { PartialType } from '@nestjs/mapped-types';
import { CreateGroqDto } from './create-groq.dto';

export class UpdateGroqDto extends PartialType(CreateGroqDto) {}
