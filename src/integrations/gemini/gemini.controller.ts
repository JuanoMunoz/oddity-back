import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  HttpCode,
  HttpStatus,
  UseInterceptors,
  UploadedFiles,
} from '@nestjs/common';
import { GeminiService } from './gemini.service';
import { ChatGeminiDto } from './dto/chat-gemini-dto';
import { FilesInterceptor } from '@nestjs/platform-express';

@Controller('/api/gemini')
export class GeminiController {
  constructor(private readonly geminiService: GeminiService) { }

  @Post()
  @HttpCode(HttpStatus.OK)
  ask(@Body() body: ChatGeminiDto) {
    return this.geminiService.chat(
      body.history,
      body.prompt,
      'ok te gustan los elefantes',
    );
  }

  @Post('file')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FilesInterceptor('files'))
  analyzeFiles(@Body() body: any, @UploadedFiles() files: Express.Multer.File[]) {
    // Para FormData, si mandan history como string
    let history = [];
    if (typeof body.history === 'string') {
      try {
        history = JSON.parse(body.history);
      } catch (e) {
        history = [];
      }
    } else if (body.history) {
      history = body.history;
    }

    const prompt = body.prompt || '';
    return this.geminiService.analyzeFiles(
      files,
      prompt,
      'ok te gustan los elefantes',
    );
  }
}
