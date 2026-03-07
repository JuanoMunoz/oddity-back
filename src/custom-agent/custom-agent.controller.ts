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
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { CustomAgentService } from './custom-agent.service';
import { CreateCustomAgentDto } from './dto/create-custom-agent.dto';
import { UpdateCustomAgentDto } from './dto/update-custom-agent.dto';
import { GeminiService } from '@/integrations/gemini/gemini.service';
import { ChatGeminiDto } from '@/integrations/gemini/dto/chat-gemini-dto';
import { IaModelService } from '@/ia-model/ia-model.service';
import { OrganizationService } from '@/organization/organization.service';

@Controller('/api/custom-agent')
export class CustomAgentController {
  constructor(
    private readonly customAgentService: CustomAgentService,
    private readonly geminiService: GeminiService,
    private readonly iaModelService: IaModelService,
    private readonly organizationService: OrganizationService,
  ) { }

  @Post()
  create(@Body() createCustomAgentDto: CreateCustomAgentDto) {
    return this.customAgentService.create(createCustomAgentDto);
  }

  @Post('analyze-to-prompt')
  @UseInterceptors(
    FilesInterceptor('files', 1, {
      limits: {
        fileSize: 20 * 1024 * 1024,
        fieldSize: 50 * 1024 * 1024 // 50MB for fields (prompt, history, etc)
      },
    }),
  )
  async analyzeToPrompt(
    @Body() body: any,
    @UploadedFiles() files?: Express.Multer.File[],
  ) {
    const modelId = Number(body.modelId);
    if (!modelId) throw new BadRequestException('modelId is required');
    if (!files || files.length === 0) throw new BadRequestException('No files uploaded');

    const model = await this.iaModelService.findOne(modelId);
    if (!model) throw new BadRequestException('Model not found');

    if (!model.name.toLowerCase().includes('google')) {
      throw new BadRequestException('Currently only Google models are supported for this feature');
    }

    const prompt = "Analiza este archivo y extrae la mayor información posible para COMPLEMENTAR un system prompt detallado. El objetivo es que el nuevo agente entienda perfectamente el contexto, estructura y datos contenidos en este archivo para poder trabajar con ellos.";
    const systemInstruction = "eres un sistema que analiza archivos y extraer la amyor informacion de estos para COMPLEMENTAR UN SYSTEM PROMPT, SOLO DEBES DEVOLVER LO QUE EXTRAIGAS DEL ARCHIVO (COLUMNAS, REGLAS, CONVENCIONES EJEMPLOS TODO, RESUMIR PERFECTAMENTE EL ARCHIVO) ";

    const result = await this.geminiService.analyzeFiles(files, prompt, systemInstruction);
    return result;
  }

  @Post('use')
  @UseInterceptors(
    FilesInterceptor('files', 10, {
      limits: {
        fileSize: 20 * 1024 * 1024, // 20MB limit per file
        fieldSize: 50 * 1024 * 1024, // 50MB for fields (prompt, history, etc)
      },
      fileFilter: (req, file, callback) => {
        const allowedMimeTypes = [
          'application/pdf',
          'text/plain',
          'text/csv',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // xlsx
          'application/vnd.ms-excel', // xls
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
        if (allowedMimeTypes.includes(file.mimetype)) {
          callback(null, true);
        } else {
          callback(
            new BadRequestException(`File type ${file.mimetype} not allowed`),
            false,
          );
        }
      },
    }),
  )
  async useAgent(
    @Body() body: any,
    @UploadedFiles() files?: Express.Multer.File[],
  ) {
    const customAgentId = Number(body.customAgentId);
    const userId: string | null = body.userId || null;
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

    const agent = await this.customAgentService.findOne(customAgentId);
    if (!agent) return { message: 'Agent not found' };

    const activeModelRel =
      await this.customAgentService.findActiveModel(customAgentId);
    if (!activeModelRel || activeModelRel.length === 0)
      return { message: 'No active model mapped to this agent' };

    const modelRecord = activeModelRel[0];
    const model = await this.iaModelService.findOne(modelRecord.modelId);
    if (!model) return { message: 'Model not found' };

    let result: { text?: string; message?: string } = {};

    // Inject CSV instruction if expected output is excel
    let finalPrompt = prompt;
    if (modelRecord.expectedOutput === 'excel') {
      finalPrompt = `${prompt}\n\nIMPORTANT: Respond ONLY with the data structure in CSV format. Do not include any other text, markdown blocks, preamble or explanations.`;
    }

    if (model.name.toLowerCase().includes('google')) {
      if (agent.mode === 'CHAT' || agent.mode === 'FILE') {
        if (files && files.length > 0) {
          // Use chunk-based processing for Excel files with excel expected output
          const hasExcel = files.some(f =>
            f.originalname.endsWith('.xlsx') ||
            f.originalname.endsWith('.xls') ||
            f.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
            f.mimetype === 'application/vnd.ms-excel'
          );
          if (hasExcel && modelRecord.expectedOutput === 'excel') {
            result = await this.geminiService.analyzeFilesChunked(
              files,
              finalPrompt,
              agent.systemPrompt,
            );
          } else {
            result = await this.geminiService.analyzeFiles(
              files,
              finalPrompt,
              agent.systemPrompt,
            );
          }
        } else {
          result = await this.geminiService.chat(
            history,
            finalPrompt,
            agent.systemPrompt,
          );
        }
      } else if (agent.mode === 'IMAGE' || agent.mode === 'VIDEO') {
        if (files && files.length > 0) {
          result = await this.geminiService.analyzeFiles(
            files,
            finalPrompt,
            agent.systemPrompt,
          );
        } else {
          return { message: `${agent.mode} mode processing requires files.` };
        }
      } else {
        return { message: 'Invalid agent mode' };
      }

      // Output Validation for Accounting
      if (modelRecord.expectedOutput === 'excel' && result.text) {
        const validation = this.geminiService.validateAccountingCSV(result.text);
        if (!validation.isValid) {
          return {
            message: `Error de Validación Contable: ${validation.error}. Por favor, revisa el prompt o los datos de entrada e intenta de nuevo.`,
            text: result.text,
            expectedOutput: modelRecord.expectedOutput, // always return so frontend can show Excel button
          };
        }
      }
    } else {
      return {
        message:
          "Model currently not integrated or model name does not include 'google'",
      };
    }

    // Add expected output info to result for frontend handling
    (result as any).expectedOutput = modelRecord.expectedOutput || 'text';

    // ---- Token & Cost Tracking ----
    try {
      const responseText = result.text || '';
      // Rough approximation: 1 token ≈ 4 chars
      const inputTokens = Math.ceil(
        (prompt.length + (agent.systemPrompt?.length || 0)) / 4,
      );
      const outputTokens = Math.ceil(responseText.length / 4);

      const priceIn = parseFloat(model.pricePerInputToken?.toString() || '0');
      const priceOut = parseFloat(model.pricePerOutputToken?.toString() || '0');
      const totalCost = inputTokens * priceIn + outputTokens * priceOut;

      await this.customAgentService.recordUsage({
        userId,
        agentId: customAgentId,
        organizationId: agent.organizationId,
        modelId: model.id,
        inputTokens,
        outputTokens,
        total: totalCost,
      });

      await this.organizationService.incrementSpent(
        agent.organizationId,
        totalCost,
      );
    } catch (trackErr) {
      console.error('Usage tracking failed:', trackErr);
    }

    return result;
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
  update(
    @Param('id') id: string,
    @Body() updateCustomAgentDto: UpdateCustomAgentDto,
  ) {
    return this.customAgentService.update(+id, updateCustomAgentDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.customAgentService.remove(+id);
  }
}
