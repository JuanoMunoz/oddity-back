import { Controller, Get, Post, Body, Patch, Param, Delete, HttpCode, HttpStatus, UseInterceptors, UploadedFile } from '@nestjs/common';
import { GeminiService } from './gemini.service';
import { ChatGeminiDto } from './dto/chat-gemini-dto';
import { FileInterceptor } from '@nestjs/platform-express';

@Controller('/api/gemini')
export class GeminiController {
  constructor(private readonly geminiService: GeminiService) { }

  @Post()
  @HttpCode(HttpStatus.OK)
  ask(@Body() body: ChatGeminiDto) {
    return this.geminiService.chat(body.history, body.prompt, "ok te gustan los elefantes");
  }

  @Post('file')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor('file'))
  analyzeFile(@Body() body: any, @UploadedFile() file: Express.Multer.File) {
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
    return this.geminiService.analyzFile(file, prompt, "ok te gustan los elefantes");
  }

}
