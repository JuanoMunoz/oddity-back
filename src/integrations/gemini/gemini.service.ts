import { Inject, Injectable } from '@nestjs/common';
import { GEMINI_AI } from './gemini-config';
import { type GoogleGenAI, type GenerateContentConfig, type Content, createPartFromUri, Part } from '@google/genai';

import type { History } from './dto/chat-gemini-dto';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

@Injectable()
export class GeminiService {
  private readonly model: string = 'gemini-2.5-flash-lite';
  private readonly config: GenerateContentConfig = {
    thinkingConfig: {
      thinkingBudget: 0,
    },
    tools: [],
    temperature: 0.2,
    maxOutputTokens: 50000,
    safetySettings: [],

  }
  constructor(
    @Inject(GEMINI_AI)
    private readonly ai: GoogleGenAI
  ) { }
  async ask(prompt: string, systemInstruction?: string) {
    const response = await this.ai.models.generateContent({
      model: this.model,
      contents: prompt,
      config: { ...this.config, systemInstruction: systemInstruction || "" }
    });
    return response;
  }

  async chat(history: History[], prompt: string, systemInstruction?: string) {
    const historyMapped: Content[] = history.map((h) => {
      return {
        role: h.role,
        parts: [
          {
            text: h.text
          }
        ]
      }
    });
    const chat = await this.ai.chats.create({
      model: this.model,
      history: historyMapped,
      config: { ...this.config, systemInstruction: systemInstruction || "" }
    });
    const response = await chat.sendMessage({ message: prompt });
    return { text: response.text };
  }

  async analyzFile(file: Express.Multer.File, prompt: string, systemInstruction?: string) {
    const tempFilePath = path.join(os.tmpdir(), `${Date.now()}-${file.originalname}`);
    await fs.writeFile(tempFilePath, file.buffer);

    try {
      const fileUploaded = await this.ai.files.upload({
        file: tempFilePath,
        config: {
          mimeType: file.mimetype,
          displayName: file.originalname,
        }
      });

      if (!fileUploaded.name || !fileUploaded.uri || !fileUploaded.mimeType) {
        throw new Error('File upload failed: missing properties returned.');
      }

      let getFile = await this.ai.files.get({ name: fileUploaded.name });
      while (getFile.state === 'PROCESSING') {
        console.log(`current file status: ${getFile.state}`);
        console.log('File is still processing, retrying in 5 seconds');

        await new Promise((resolve) => {
          setTimeout(resolve, 5000);
        });
        getFile = await this.ai.files.get({ name: fileUploaded.name });
      }
      if (getFile.state === 'FAILED') {
        throw new Error('File processing failed.');
      }
      const parts: Part[] = [
        { text: prompt }
      ];

      if (fileUploaded.uri && fileUploaded.mimeType) {
        parts.push(
          createPartFromUri(fileUploaded.uri, fileUploaded.mimeType)
        );
      }
      const contents: Content[] = [
        {
          role: "user",
          parts
        }
      ];
      const response = await this.ai.models.generateContent({
        model: this.model,
        contents: contents,
        config: { ...this.config, systemInstruction: systemInstruction || "" }
      });
      return { text: response.text };
    } finally {
      await fs.unlink(tempFilePath).catch(() => { });
    }
  }
}
