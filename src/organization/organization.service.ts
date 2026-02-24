import { Injectable, Inject } from '@nestjs/common';
import { CreateOrganizationDto } from './dto/create-organization.dto';
import { UpdateOrganizationDto } from './dto/update-organization.dto';
import { DRIZZLE } from '@/db/db.module';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from '@/db/schema';
import { eq, gte, sql } from 'drizzle-orm';

@Injectable()
export class OrganizationService {
  constructor(
    @Inject(DRIZZLE) private db: PostgresJsDatabase<typeof schema>,
  ) { }

  async create(createOrganizationDto: CreateOrganizationDto) {
    const [newOrg] = await this.db.insert(schema.organization).values({
      ...createOrganizationDto,
      currentSpent: createOrganizationDto.currentSpent?.toString() || "0",
      monthlySpendingLimit: createOrganizationDto.monthlySpendingLimit.toString(),
    }).returning();
    return newOrg;
  }

  async findAll() {
    return await this.db.select().from(schema.organization);
  }

  async findOne(id: number) {
    const [org] = await this.db.select().from(schema.organization).where(eq(schema.organization.id, id));
    return org || null;
  }

  async update(id: number, updateOrganizationDto: UpdateOrganizationDto) {
    const updateData: any = { ...updateOrganizationDto };

    if (updateOrganizationDto.monthlySpendingLimit) {
      updateData.monthlySpendingLimit = updateOrganizationDto.monthlySpendingLimit.toString();
    }
    if (updateOrganizationDto.currentSpent) {
      updateData.currentSpent = updateOrganizationDto.currentSpent.toString();
    }

    const [updatedOrg] = await this.db
      .update(schema.organization)
      .set(updateData)
      .where(eq(schema.organization.id, id))
      .returning();
    return updatedOrg;
  }

  async remove(id: number) {
    await this.db.delete(schema.organization).where(eq(schema.organization.id, id));
    return { id };
  }

  async findOrganizationAgents(organizationId: number) {
    return this.db
      .select()
      .from(schema.customAgent)
      .where(eq(schema.customAgent.organizationId, organizationId));
  }

  async findOrganizationUsers(organizationId: number) {
    return this.db
      .select()
      .from(schema.user)
      .where(eq(schema.user.organizationId, organizationId));
  }

  async findOrganizationUsages(organizationId: number) {
    return this.db
      .select()
      .from(schema.agentUsage)
      .where(eq(schema.agentUsage.organizationId, organizationId));
  }

  async incrementSpent(organizationId: number, amount: number) {
    const org = await this.findOne(organizationId);
    if (!org) return;
    const currentSpent = parseFloat(org.currentSpent?.toString() || '0');
    await this.db
      .update(schema.organization)
      .set({ currentSpent: (currentSpent + amount).toFixed(8) })
      .where(eq(schema.organization.id, organizationId));
  }

  async getUsageStats(organizationId: number, period: 'today' | '30d' | '90d') {
    const now = new Date();
    let since: Date;
    if (period === 'today') {
      since = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    } else if (period === '30d') {
      since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    } else {
      since = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    }

    const rows = await this.db
      .select()
      .from(schema.agentUsage)
      .where(
        sql`${schema.agentUsage.organizationId} = ${organizationId}
            AND ${schema.agentUsage.createdAt} >= ${since.toISOString()}`
      );

    const totalInputTokens = rows.reduce((s, r) => s + (r.inputTokens || 0), 0);
    const totalOutputTokens = rows.reduce((s, r) => s + (r.outputTokens || 0), 0);
    const totalCost = rows.reduce((s, r) => s + parseFloat(r.total?.toString() || '0'), 0);

    return {
      period,
      rows,
      totalInputTokens,
      totalOutputTokens,
      totalCost: totalCost.toFixed(8),
      callCount: rows.length,
    };
  }
}
