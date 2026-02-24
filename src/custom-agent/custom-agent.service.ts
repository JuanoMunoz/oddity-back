import { Injectable, Inject } from '@nestjs/common';
import { CreateCustomAgentDto } from './dto/create-custom-agent.dto';
import { UpdateCustomAgentDto } from './dto/update-custom-agent.dto';
import { DRIZZLE } from '@/db/db.module';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from '@/db/schema';
import { eq, and, desc } from 'drizzle-orm';

@Injectable()
export class CustomAgentService {
  constructor(
    @Inject(DRIZZLE) private db: PostgresJsDatabase<typeof schema>,
  ) { }

  async create(createCustomAgentDto: CreateCustomAgentDto) {
    const { modelId, ...agentData } = createCustomAgentDto;
    const [newAgent] = await this.db.insert(schema.customAgent).values({
      ...agentData,
    }).returning();

    if (modelId) {
      await this.db.insert(schema.customAgentModel).values({
        customAgentId: newAgent.id,
        modelId,
        priority: 1,
        isActive: true,
      });
    }

    return newAgent;
  }

  async findAll() {
    return await this.db.select().from(schema.customAgent);
  }

  async findOne(id: number) {
    const [agent] = await this.db.select().from(schema.customAgent).where(eq(schema.customAgent.id, id));
    return agent || null;
  }

  async update(id: number, updateCustomAgentDto: UpdateCustomAgentDto) {
    const { modelId, ...updateData } = updateCustomAgentDto as any;
    let updatedAgent;

    if (Object.keys(updateData).length > 0) {
      [updatedAgent] = await this.db
        .update(schema.customAgent)
        .set(updateData)
        .where(eq(schema.customAgent.id, id))
        .returning();
    } else {
      updatedAgent = await this.findOne(id);
    }

    if (modelId) {
      await this.db.update(schema.customAgentModel)
        .set({ isActive: false })
        .where(eq(schema.customAgentModel.customAgentId, id));

      await this.db.insert(schema.customAgentModel).values({
        customAgentId: id,
        modelId,
        priority: 1,
        isActive: true,
      });
    }

    return updatedAgent;
  }

  async remove(id: number) {
    await this.db.delete(schema.customAgent).where(eq(schema.customAgent.id, id));
    return { id };
  }

  async findActiveModel(customAgentId: number) {
    return this.db
      .select()
      .from(schema.customAgentModel)
      .where(
        and(
          eq(schema.customAgentModel.customAgentId, customAgentId),
          eq(schema.customAgentModel.isActive, true)
        )
      )
      .orderBy(desc(schema.customAgentModel.priority))
      .limit(1);
  }

  async findAgentModels(customAgentId: number) {
    return this.db
      .select()
      .from(schema.customAgentModel)
      .where(eq(schema.customAgentModel.customAgentId, customAgentId));
  }

  async findAgentUsages(customAgentId: number) {
    return this.db
      .select()
      .from(schema.agentUsage)
      .where(eq(schema.agentUsage.agentId, customAgentId));
  }

  async recordUsage(data: {
    userId: string | null;
    agentId: number;
    organizationId: number;
    modelId: number;
    inputTokens: number;
    outputTokens: number;
    total: number;
  }) {
    return this.db.insert(schema.agentUsage).values({
      userId: data.userId,
      agentId: data.agentId,
      organizationId: data.organizationId,
      modelId: data.modelId,
      inputTokens: data.inputTokens,
      outputTokens: data.outputTokens,
      total: data.total.toFixed(8),
    }).returning();
  }
}
