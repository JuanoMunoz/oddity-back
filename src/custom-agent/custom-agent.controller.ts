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
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { CustomAgentService } from './custom-agent.service';
import { CreateCustomAgentDto } from './dto/create-custom-agent.dto';
import { UpdateCustomAgentDto } from './dto/update-custom-agent.dto';
import { GeminiService } from '@/integrations/gemini/gemini.service';
import { ChatGeminiDto } from '@/integrations/gemini/dto/chat-gemini-dto';
import { IaModelService } from '@/ia-model/ia-model.service';
import { OrganizationService } from '@/organization/organization.service';
import * as fs from 'fs';
import * as fsAsync from 'fs/promises';
import * as crypto from 'crypto';

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
  @UseInterceptors(FilesInterceptor('files', 10, UPLOAD_OPTIONS))
  async useAgentStreamExcel(

    @Body() body: any,
    @UploadedFiles() files: Express.Multer.File[] | undefined,
    @Res() res: any,
  ) {
    const customAgentId = Number(body.customAgentId);
    const userId: string | null = body.userId || null;
    const prompt = body.prompt || '';

    if (!files || files.length === 0)
      throw new BadRequestException('No files uploaded');

    const excelFiles = files.filter(f => this.geminiService.isExcelFile(f));
    if (excelFiles.length === 0)
      throw new BadRequestException('No Excel files found in upload');

    const agent = await this.customAgentService.findOne(customAgentId);
    if (!agent) return res.status(404).json({ message: 'Agent not found' });

    const activeModelRel = await this.customAgentService.findActiveModel(customAgentId);
    if (!activeModelRel || activeModelRel.length === 0)
      return res.status(400).json({ message: 'No active model mapped to this agent' });

    const modelRecord = activeModelRel[0];
    const model = await this.iaModelService.findOne(modelRecord.modelId);
    if (!model) return res.status(404).json({ message: 'Model not found' });

    if (!model.name.toLowerCase().includes('google'))
      return res.status(400).json({ message: "Only Google models are supported." });

    const finalPrompt =
      `${prompt}\n\nIMPORTANT: Respond ONLY with the data structure in CSV format. ` +
      `Do not include any other text, markdown blocks, preamble or explanations.`;

    // Unique jobId for checkpoint tracking
    const jobId = crypto.randomBytes(8).toString('hex');

    // ── Set streaming response headers ──
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="result.xlsx"');

    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Pipeline-JobId', jobId);
    res.flushHeaders();

    const excelFile = excelFiles[0]; // primary file

    // ── Pipe streaming pipeline directly into HTTP response ──
    const pipelineStream = this.geminiService.streamExcelPipeline(
      excelFile,
      finalPrompt,
      agent.systemPrompt || '',
      jobId,
      (msg) => console.log(`[StreamCSV] jobId=${jobId} progress: ${msg}`),
    );

    // On stream error → abort response
    pipelineStream.on('error', (err) => {
      console.error(`[StreamCSV] jobId=${jobId} pipeline error:`, err.message);
      if (!res.headersSent) {
        res.status(500).json({ message: 'Pipeline failed: ' + err.message });
      } else {
        res.end();
      }
    });

    pipelineStream.on('end', async () => {
      console.log(`[StreamCSV] jobId=${jobId} stream complete.`);

      // Usage tracking (non-fatal, best-effort)
      try {
        const inputTokens = Math.ceil((prompt.length + (agent.systemPrompt?.length || 0)) / 4);
        // Output tokens unknown at this point — use prompt as proxy
        const outputTokens = inputTokens * 10; // conservative estimate
        const priceIn = parseFloat(model.pricePerInputToken?.toString() || '0');
        const priceOut = parseFloat(model.pricePerOutputToken?.toString() || '0');
        const totalCost = inputTokens * priceIn + outputTokens * priceOut;
        await this.customAgentService.recordUsage({
          userId, agentId: customAgentId, organizationId: agent.organizationId,
          modelId: model.id, inputTokens, outputTokens, total: totalCost,
        });
        await this.organizationService.incrementSpent(agent.organizationId, totalCost);
      } catch (trackErr) {
        console.error('[StreamCSV] Usage tracking failed:', trackErr);
      }
    });

    // Pipe: pipelineStream → HTTP response (with backpressure)
    pipelineStream.pipe(res);
  }
}
