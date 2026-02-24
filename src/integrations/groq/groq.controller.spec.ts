import { Test, TestingModule } from '@nestjs/testing';
import { GroqController } from './groq.controller';
import { GroqService } from './groq.service';

describe('GroqController', () => {
  let controller: GroqController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [GroqController],
      providers: [GroqService],
    }).compile();

    controller = module.get<GroqController>(GroqController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
