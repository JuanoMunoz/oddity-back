import { Controller, Get, Post, Body, Patch, Param, Delete } from '@nestjs/common';
import { GroqService } from './groq.service';
import { CreateGroqDto } from './dto/create-groq.dto';
import { UpdateGroqDto } from './dto/update-groq.dto';

@Controller('groq')
export class GroqController {
  constructor(private readonly groqService: GroqService) {}

  @Post()
  create(@Body() createGroqDto: CreateGroqDto) {
    return this.groqService.create(createGroqDto);
  }

  @Get()
  findAll() {
    return this.groqService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.groqService.findOne(+id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() updateGroqDto: UpdateGroqDto) {
    return this.groqService.update(+id, updateGroqDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.groqService.remove(+id);
  }
}
