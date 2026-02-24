import { Injectable } from '@nestjs/common';
import { CreateGroqDto } from './dto/create-groq.dto';
import { UpdateGroqDto } from './dto/update-groq.dto';

@Injectable()
export class GroqService {
  create(createGroqDto: CreateGroqDto) {
    return 'This action adds a new groq';
  }

  findAll() {
    return `This action returns all groq`;
  }

  findOne(id: number) {
    return `This action returns a #${id} groq`;
  }

  update(id: number, updateGroqDto: UpdateGroqDto) {
    return `This action updates a #${id} groq`;
  }

  remove(id: number) {
    return `This action removes a #${id} groq`;
  }
}
