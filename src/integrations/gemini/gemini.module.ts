import { Module } from '@nestjs/common';
import { GeminiService } from './gemini.service';
import { GeminiController } from './gemini.controller';
import { GEMINI_AI, ia } from './gemini-config';

@Module({
  controllers: [GeminiController],
  providers: [GeminiService, {
    provide: GEMINI_AI,
    useValue: ia
  }],
  exports: [GeminiService],
})
export class GeminiModule { }
