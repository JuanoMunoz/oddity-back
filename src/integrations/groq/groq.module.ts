import { Module } from '@nestjs/common';
import { GroqService } from './groq.service';
import { GroqController } from './groq.controller';

@Module({
  controllers: [GroqController],
  providers: [GroqService],
})
export class GroqModule {}
