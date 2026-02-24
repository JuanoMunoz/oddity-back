import { Module } from '@nestjs/common';
import { IaModelService } from './ia-model.service';
import { IaModelController } from './ia-model.controller';

@Module({
  controllers: [IaModelController],
  providers: [IaModelService],
  exports: [IaModelService],
})
export class IaModelModule { }
