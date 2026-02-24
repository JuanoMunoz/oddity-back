import { Module } from '@nestjs/common';
import { CustomAgentService } from './custom-agent.service';
import { CustomAgentController } from './custom-agent.controller';

import { GeminiModule } from '@/integrations/gemini/gemini.module';
import { IaModelModule } from '@/ia-model/ia-model.module';
import { OrganizationModule } from '@/organization/organization.module';

@Module({
  imports: [GeminiModule, IaModelModule, OrganizationModule],
  controllers: [CustomAgentController],
  providers: [CustomAgentService],
})
export class CustomAgentModule { }
