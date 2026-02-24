import { Controller, Get, Post, Body, Patch, Param, Delete, UseInterceptors, UploadedFile } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
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

  @Post('use')
  @UseInterceptors(FileInterceptor('file'))
  async useAgent(
    @Body() body: any,
    @UploadedFile() file?: Express.Multer.File
  ) {
    const customAgentId = Number(body.customAgentId);
    const userId: string | null = body.userId || null;
    let history = [];
    if (typeof body.history === 'string') {
      try { history = JSON.parse(body.history); } catch (e) { history = []; }
    } else if (body.history) {
      history = body.history;
    }
    const prompt = body.prompt || '';

    const agent = await this.customAgentService.findOne(customAgentId);
    if (!agent) return { message: "Agent not found" };

    const activeModelRel = await this.customAgentService.findActiveModel(customAgentId);
    if (!activeModelRel || activeModelRel.length === 0)
      return { message: "No active model mapped to this agent" };

    const model = await this.iaModelService.findOne(activeModelRel[0].modelId);
    if (!model) return { message: "Model not found" };

    let result: { text?: string; message?: string } = {};

    if (model.name.toLowerCase().includes('google')) {
      if (agent.mode === 'CHAT') {
        result = await this.geminiService.chat(history, prompt, agent.systemPrompt);
      } else if (agent.mode === 'FILE') {
        if (!file) return { message: 'File mode requires a file to be uploaded' };
        result = await this.geminiService.analyzFile(file, prompt, agent.systemPrompt);
      } else if (agent.mode === 'IMAGE' || agent.mode === 'VIDEO') {
        return { message: `${agent.mode} mode processing not currently mapped to an adapter method.` };
      } else {
        return { message: 'Invalid agent mode' };
      }
    } else {
      return { message: "Model currently not integrated or model name does not include 'google'" };
    }

    // ---- Token & Cost Tracking ----
    try {
      const responseText = result.text || '';
      // Rough approximation: 1 token ≈ 4 chars
      const inputTokens = Math.ceil((prompt.length + (agent.systemPrompt?.length || 0)) / 4);
      const outputTokens = Math.ceil(responseText.length / 4);

      const priceIn = parseFloat(model.pricePerInputToken?.toString() || '0');
      const priceOut = parseFloat(model.pricePerOutputToken?.toString() || '0');
      const totalCost = (inputTokens * priceIn) + (outputTokens * priceOut);

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
      console.error('Usage tracking failed:', trackErr);
    }

    return result;
  }

  @Get()
  findAll() {
    return this.customAgentService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.customAgentService.findOne(+id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() updateCustomAgentDto: UpdateCustomAgentDto) {
    return this.customAgentService.update(+id, updateCustomAgentDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.customAgentService.remove(+id);
  }
}
