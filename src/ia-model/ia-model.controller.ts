import { Controller, Get, Post, Body, Patch, Param, Delete } from '@nestjs/common';
import { IaModelService } from './ia-model.service';
import { CreateIaModelDto } from './dto/create-ia-model.dto';
import { UpdateIaModelDto } from './dto/update-ia-model.dto';

@Controller('/api/ia-model')
export class IaModelController {
  constructor(private readonly iaModelService: IaModelService) { }

  @Post()
  create(@Body() createIaModelDto: CreateIaModelDto) {
    return this.iaModelService.create(createIaModelDto);
  }

  @Get()
  findAll() {
    return this.iaModelService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.iaModelService.findOne(+id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() updateIaModelDto: UpdateIaModelDto) {
    return this.iaModelService.update(+id, updateIaModelDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.iaModelService.remove(+id);
  }
}
