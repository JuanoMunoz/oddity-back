import { Injectable, Inject } from '@nestjs/common';
import { CreateIaModelDto } from './dto/create-ia-model.dto';
import { UpdateIaModelDto } from './dto/update-ia-model.dto';
import { DRIZZLE } from '@/db/db.module';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from '@/db/schema';
import { eq } from 'drizzle-orm';

@Injectable()
export class IaModelService {
  constructor(
    @Inject(DRIZZLE) private db: PostgresJsDatabase<typeof schema>,
  ) { }

  async create(createIaModelDto: CreateIaModelDto) {
    const [newModel] = await this.db.insert(schema.iaModel).values({
      ...createIaModelDto,
      pricePerInputToken: createIaModelDto.pricePerInputToken.toString(),
      pricePerOutputToken: createIaModelDto.pricePerOutputToken.toString(),
    }).returning();
    return newModel;
  }

  async findAll() {
    return await this.db.select().from(schema.iaModel);
  }

  async findOne(id: number) {
    const [model] = await this.db.select().from(schema.iaModel).where(eq(schema.iaModel.id, id));
    return model || null;
  }

  async update(id: number, updateIaModelDto: UpdateIaModelDto) {
    const updateData: any = { ...updateIaModelDto };

    if (updateIaModelDto.pricePerInputToken !== undefined) {
      updateData.pricePerInputToken = updateIaModelDto.pricePerInputToken.toString();
    }
    if (updateIaModelDto.pricePerOutputToken !== undefined) {
      updateData.pricePerOutputToken = updateIaModelDto.pricePerOutputToken.toString();
    }

    const [updatedModel] = await this.db
      .update(schema.iaModel)
      .set(updateData)
      .where(eq(schema.iaModel.id, id))
      .returning();
    return updatedModel;
  }

  async remove(id: number) {
    await this.db.delete(schema.iaModel).where(eq(schema.iaModel.id, id));
    return { id };
  }

  async findModelAgents(modelId: number) {
    return this.db
      .select()
      .from(schema.customAgentModel)
      .where(eq(schema.customAgentModel.modelId, modelId));
  }

  async findModelUsages(modelId: number) {
    return this.db
      .select()
      .from(schema.agentUsage)
      .where(eq(schema.agentUsage.modelId, modelId));
  }
}
