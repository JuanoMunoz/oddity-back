import { Module } from '@nestjs/common';
import { AuthModule } from '@thallesp/nestjs-better-auth';
import { auth } from './auth.config';
import { DbModule } from './db/db.module';
import { OrganizationModule } from './organization/organization.module';
import { IaModelModule } from './ia-model/ia-model.module';
import { CustomAgentModule } from './custom-agent/custom-agent.module';
import { GeminiModule } from './integrations/gemini/gemini.module';
import { GroqModule } from './integrations/groq/groq.module';

@Module({
  imports: [
    AuthModule.forRoot(auth),
    DbModule,
    OrganizationModule,
    IaModelModule,
    CustomAgentModule,
    GeminiModule,
    GroqModule
  ],
})
export class AppModule { }
