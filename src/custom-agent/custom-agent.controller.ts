import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseInterceptors,
  UploadedFiles,
  BadRequestException,
  Res,
  HttpCode,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import { FilesInterceptor, FileFieldsInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { PassThrough } from 'stream';

import { CustomAgentService } from './custom-agent.service';
import { CreateCustomAgentDto } from './dto/create-custom-agent.dto';
import { UpdateCustomAgentDto } from './dto/update-custom-agent.dto';
import { GeminiService, type CategorizedFiles } from '@/integrations/gemini/gemini.service';

import { ChatGeminiDto } from '@/integrations/gemini/dto/chat-gemini-dto';
import { IaModelService } from '@/ia-model/ia-model.service';
import { OrganizationService } from '@/organization/organization.service';
import * as fs from 'fs';
import * as fsSync from 'fs';
import * as fsAsync from 'fs/promises';
import * as crypto from 'crypto';
import * as path from 'path';

// ─── Shared multer options for file uploads ──────────────────
const UPLOAD_OPTIONS = {
  limits: {
    fileSize: 200 * 1024 * 1024,  // 200 MB — large Excel files
    fieldSize: 50 * 1024 * 1024,  // 50 MB for body fields
  },
  fileFilter: (_req: any, file: Express.Multer.File, cb: any) => {
    const allowed = [
      'application/pdf',
      'text/plain',
      'text/csv',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
      'image/png',
      'image/jpeg',
      'image/webp',
      'video/mp4',
      'video/mpeg',
      'video/quicktime',
      'audio/mpeg',
      'audio/mp3',
      'audio/wav',
    ];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new BadRequestException(`File type ${file.mimetype} not allowed`), false);
    }
  },
};

@Controller('/api/custom-agent')
export class CustomAgentController {
  constructor(
    private readonly customAgentService: CustomAgentService,
    private readonly geminiService: GeminiService,
    private readonly iaModelService: IaModelService,
    private readonly organizationService: OrganizationService,
  ) { }

  // ─────────────────────────────────────────────
  // CRUD
  // ─────────────────────────────────────────────

  @Post()
  create(@Body() createCustomAgentDto: CreateCustomAgentDto) {
    return this.customAgentService.create(createCustomAgentDto);
  }

  @Get()
  findAll() {
    return this.customAgentService.findAll();
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    const agent = await this.customAgentService.findOne(+id);
    if (!agent) return { message: 'Agent not found' };
    const activeModelRel = await this.customAgentService.findActiveModel(+id);
    if (activeModelRel && activeModelRel.length > 0) {
      return {
        ...agent,
        modelId: activeModelRel[0].modelId,
        expectedOutput: activeModelRel[0].expectedOutput,
      };
    }
    return agent;
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() updateCustomAgentDto: UpdateCustomAgentDto) {
    return this.customAgentService.update(+id, updateCustomAgentDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.customAgentService.remove(+id);
  }

  // ─────────────────────────────────────────────
  // analyzeToPrompt — File → system-prompt extraction
  // ─────────────────────────────────────────────

  @Post('analyze-to-prompt')
  @UseInterceptors(FilesInterceptor('files', 1, UPLOAD_OPTIONS))
  async analyzeToPrompt(
    @Body() body: any,
    @UploadedFiles() files?: Express.Multer.File[],
  ) {
    const modelId = Number(body.modelId);
    if (!modelId) throw new BadRequestException('modelId is required');
    if (!files || files.length === 0) throw new BadRequestException('No files uploaded');

    const model = await this.iaModelService.findOne(modelId);
    if (!model) throw new BadRequestException('Model not found');
    if (!model.name.toLowerCase().includes('google'))
      throw new BadRequestException('Currently only Google models are supported for this feature');

    const prompt =
      'Analiza este archivo y extrae la mayor información posible para COMPLEMENTAR un system prompt detallado. ' +
      'El objetivo es que el nuevo agente entienda perfectamente el contexto, estructura y datos contenidos en este archivo.';
    const systemInstruction =
      'Eres un sistema que analiza archivos y extrae la mayor información de estos para COMPLEMENTAR UN SYSTEM PROMPT. ' +
      'SOLO DEBES DEVOLVER LO QUE EXTRAIGAS DEL ARCHIVO (COLUMNAS, REGLAS, CONVENCIONES, EJEMPLOS, TODO — RESUMIR PERFECTAMENTE EL ARCHIVO).';

    return this.geminiService.analyzeFiles(files, prompt, systemInstruction);
  }

  // ─────────────────────────────────────────────
  // useAgent — SSE endpoint
  //
  // Handles: chat, image, video, small file analysis.
  // For large Excel → expectedOutput=excel, use /use/stream-csv instead.
  //
  // The SSE stream sends:
  //   { type: 'progress', message }
  //   { type: 'complete', result }
  //   { type: 'error',    message }
  // ─────────────────────────────────────────────

  @Post('use')
  @UseInterceptors(FilesInterceptor('files', 10, UPLOAD_OPTIONS))
  async useAgent(
    @Body() body: any,
    @UploadedFiles() files: Express.Multer.File[] | undefined,
    @Res() res: any,
  ) {
    const customAgentId = Number(body.customAgentId);
    const userId: string | null = body.userId || null;
    let history: any[] = [];
    if (typeof body.history === 'string') {
      try { history = JSON.parse(body.history); } catch { history = []; }
    } else if (body.history) {
      history = body.history;
    }
    const prompt = body.prompt || '';

    const agent = await this.customAgentService.findOne(customAgentId);
    if (!agent) return res.status(404).json({ message: 'Agent not found' });

    const activeModelRel = await this.customAgentService.findActiveModel(customAgentId);
    if (!activeModelRel || activeModelRel.length === 0)
      return res.status(400).json({ message: 'No active model mapped to this agent' });

    const modelRecord = activeModelRel[0];
    const model = await this.iaModelService.findOne(modelRecord.modelId);
    if (!model) return res.status(404).json({ message: 'Model not found' });

    if (!model.name.toLowerCase().includes('google')) {
      return res.status(400).json({
        message: "Model currently not integrated or name does not include 'google'",
      });
    }

    // ── Open SSE stream ──
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const sendEvent = (payload: Record<string, any>) =>
      res.write(`data: ${JSON.stringify(payload)}\n\n`);

    const sendProgress = (msg: string) =>
      sendEvent({ type: 'progress', message: msg });

    let finalPrompt = prompt;
    if (modelRecord.expectedOutput === 'excel') {
      finalPrompt =
        `${prompt}\n\nIMPORTANT: Respond ONLY with the data structure in CSV format. ` +
        `Do not include any other text, markdown blocks, preamble or explanations.`;
    }

    let result: { text?: string; message?: string; expectedOutput?: string } = {};

    try {
      if (agent.mode === 'CHAT' || agent.mode === 'FILE') {
        if (files && files.length > 0) {
          const hasLargeExcel = files.some(f => this.geminiService.isExcelFile(f));

          if (hasLargeExcel && modelRecord.expectedOutput === 'excel') {
            // ── Redirect client to the streaming download endpoint ──
            sendEvent({
              type: 'redirect',
              message: 'Large Excel detected — use /api/custom-agent/use/stream-excel for download.',
              endpoint: '/api/custom-agent/use/stream-excel',
            });
            return res.end();
          } else {
            result = await this.geminiService.analyzeFiles(files, finalPrompt, agent.systemPrompt);
          }
        } else {
          result = await this.geminiService.chat(history, finalPrompt, agent.systemPrompt);
        }
      } else if (agent.mode === 'IMAGE' || agent.mode === 'VIDEO') {
        if (files && files.length > 0) {
          result = await this.geminiService.analyzeFiles(files, finalPrompt, agent.systemPrompt);
        } else {
          sendEvent({ type: 'error', message: `${agent.mode} mode requires files.` });
          return res.end();
        }
      } else {
        sendEvent({ type: 'error', message: 'Invalid agent mode.' });
        return res.end();
      }

      if (modelRecord.expectedOutput === 'excel' && result.text) {
        const validation = this.geminiService.validateAccountingCSV(result.text);
        if (!validation.isValid) {
          result.message =
            `Error de Validación Contable: ${validation.error}. ` +
            `Por favor, revisa el prompt o los datos de entrada e intenta de nuevo.`;
        }
      }
    } catch (err: any) {
      console.error('[CustomAgent] useAgent error:', err?.message ?? err);
      sendEvent({ type: 'error', message: err?.message || 'Internal error' });
      return res.end();
    }

    result.expectedOutput = modelRecord.expectedOutput || 'text';

    // ── Usage tracking (non-fatal) ──
    try {
      const responseText = result.text || '';
      const inputTokens = Math.ceil((prompt.length + (agent.systemPrompt?.length || 0)) / 4);
      const outputTokens = Math.ceil(responseText.length / 4);
      const priceIn = parseFloat(model.pricePerInputToken?.toString() || '0');
      const priceOut = parseFloat(model.pricePerOutputToken?.toString() || '0');
      const totalCost = inputTokens * priceIn + outputTokens * priceOut;
      await this.customAgentService.recordUsage({
        userId, agentId: customAgentId, organizationId: agent.organizationId,
        modelId: model.id, inputTokens, outputTokens, total: totalCost,
      });
      await this.organizationService.incrementSpent(agent.organizationId, totalCost);
    } catch (trackErr) {
      console.error('[CustomAgent] Usage tracking failed:', trackErr);
    }

    sendEvent({ type: 'complete', result });
    res.end();
  }

  // ─────────────────────────────────────────────
  // useAgent/stream-csv — TRUE STREAMING DOWNLOAD
  //
  // For large Excel files with expectedOutput=excel.
  //
  // Response:
  //   Content-Type: text/csv
  //   Content-Disposition: attachment; filename="result.csv"
  //   Transfer-Encoding: chunked    (Node default for piped streams)
  //
  // The pipeline writes directly into the HTTP response stream.
  // No file is accumulated in memory.
  // ─────────────────────────────────────────────
@Post('use/stream-excel')
@UseInterceptors(FileFieldsInterceptor([
  { name: 'formatFile', maxCount: 1 },
  { name: 'inputFile', maxCount: 1 },
  { name: 'supportFiles', maxCount: 10 },
  { name: 'files', maxCount: 10 },
], UPLOAD_OPTIONS))
async useAgentStreamExcel(
  @Body() body: any,
  @UploadedFiles() files: {
    formatFile?: Express.Multer.File[],
    inputFile?: Express.Multer.File[],
    supportFiles?: Express.Multer.File[],
    files?: Express.Multer.File[],
  },
  @Res() res: any,
) {
  const customAgentId = Number(body.customAgentId);
  const userId = body.userId || null;
  const prompt = body.prompt || '';

  const mainInput = files.inputFile?.[0] || files.files?.[0];
  if (!mainInput) throw new BadRequestException('No input file provided');

  const categorizedFiles: CategorizedFiles = {
    formatFile: files.formatFile?.[0],
    inputFile: mainInput,
    supportFiles: files.supportFiles || [],
  };

  const agent = await this.customAgentService.findOne(customAgentId);
  if (!agent) return res.status(404).json({ message: 'Agent not found' });

  const activeModelRel = await this.customAgentService.findActiveModel(customAgentId);
  if (!activeModelRel?.length)
    return res.status(400).json({ message: 'No active model mapped to this agent' });

  const modelRecord = activeModelRel[0];
  const model = await this.iaModelService.findOne(modelRecord.modelId);
  if (!model) return res.status(404).json({ message: 'Model not found' });
  if (!model.name.toLowerCase().includes('google'))
    return res.status(400).json({ message: 'Only Google models are supported.' });

  const finalPrompt =
    `${prompt}\n\nIMPORTANT: Respond ONLY with CSV rows. ` +
    `No markdown, no preamble, no explanations.`;

  const jobId = crypto.randomBytes(8).toString('hex');

  // ── SSE headers ──
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendEvent = (payload: Record<string, any>) => {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    }
  };

  // ── onProgress ahora SÍ llega al cliente ──
  const onProgress = (msg: string) => {
    console.log(`[StreamSSE] jobId=${jobId} progress: ${msg}`);
    sendEvent({ type: 'progress', message: msg });
  };

  const modelInfo = {
    pricePerInputToken: parseFloat(model.pricePerInputToken?.toString() || '0'),
    pricePerOutputToken: parseFloat(model.pricePerOutputToken?.toString() || '0'),
  };

  let pipelineStream: PassThrough;
  try {
    pipelineStream = this.geminiService.streamExcelPipeline(
      categorizedFiles,
      finalPrompt,
      agent.systemPrompt || '',
      jobId,
      onProgress,
      modelInfo,
    );
  } catch (err: any) {
    sendEvent({ type: 'error', message: err?.message || 'Failed to start pipeline' });
    return res.end();
  }

  // ── Manejo de eventos SIN pipe() para tener control total ──
  pipelineStream.on('data', (chunk: Buffer) => {
    // El pipeline ya emite SSE formateado, lo pasamos directo
    if (!res.writableEnded) {
      res.write(chunk);
    }
  });

  pipelineStream.on('error', (err) => {
    console.error(`[StreamSSE] jobId=${jobId} pipeline error:`, err.message);
    sendEvent({ type: 'error', message: err.message });
    if (!res.writableEnded) res.end();
  });

  pipelineStream.on('end', async () => {
    console.log(`[StreamSSE] jobId=${jobId} pipeline finished.`);

    // Usage tracking con datos reales del complete event
    // (el pipeline ya los calculó y los envió via SSE al cliente)
    try {
      const inputTokens = Math.ceil(
        (prompt.length + (agent.systemPrompt?.length || 0)) / 4
      );
      // Estimación conservadora basada en el archivo procesado
      const outputTokens = Math.ceil(mainInput.size / 4);
      const totalCost =
        inputTokens * modelInfo.pricePerInputToken +
        outputTokens * modelInfo.pricePerOutputToken;

      await this.customAgentService.recordUsage({
        userId,
        agentId: customAgentId,
        organizationId: agent.organizationId,
        modelId: model.id,
        inputTokens,
        outputTokens,
        total: totalCost,
      });
      await this.organizationService.incrementSpent(agent.organizationId, totalCost);
    } catch (trackErr) {
      console.error('[StreamSSE] Usage tracking failed:', trackErr);
    }

    if (!res.writableEnded) res.end();
  });

  // ── Cleanup si el cliente desconecta ──
  res.on('close', () => {
    if (!pipelineStream.destroyed) {
      pipelineStream.destroy();
      console.log(`[StreamSSE] jobId=${jobId} client disconnected, pipeline destroyed.`);
    }
  });
}

// ── Download con validación de userId ──
@Get('download/:jobId')
async downloadResult(
  @Param('jobId') jobId: string,
  @Res() res: any,
) {
  // Sanitizar jobId para evitar path traversal
  if (!/^[a-f0-9]{16}$/.test(jobId)) {
    throw new BadRequestException('Invalid jobId format');
  }

  const filePath = path.join(process.cwd(), 'results', `${jobId}.xlsx`);

  if (!fsSync.existsSync(filePath)) {
    throw new NotFoundException('File not found or already expired.');
  }

  res.download(filePath, `result_${jobId}.xlsx`, (err: any) => {
    if (err && !res.headersSent) {
      console.error('[Download] Error sending file:', err.message);
    }
  });
}}


