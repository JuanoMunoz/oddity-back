import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { OrganizationService } from './organization.service';
import { CreateOrganizationDto } from './dto/create-organization.dto';
import { UpdateOrganizationDto } from './dto/update-organization.dto';

@Controller('api/organization')
export class OrganizationController {
  constructor(private readonly organizationService: OrganizationService) { }

  @Post()
  create(@Body() createOrganizationDto: CreateOrganizationDto) {
    return this.organizationService.create(createOrganizationDto);
  }

  /**
   * Links a user to an organization via access token.
   * POST /api/organization/link
   * Body: { accessToken: string, userId: string }
   */
  @Post('link')
  async linkUserToOrganization(
    @Body() body: { accessToken: string; userId: string },
  ) {
    const { accessToken, userId } = body;
    if (!accessToken || !userId) {
      throw new BadRequestException('accessToken and userId are required');
    }

    const org = await this.organizationService.findByAccessToken(accessToken);
    if (!org) {
      throw new NotFoundException('Código de acceso no válido. No se encontró ninguna organización.');
    }

    // Update organizationId directly in the user table
    await this.organizationService.linkUserToOrganization(userId, org.id);

    const agents = await this.organizationService.findOrganizationAgents(org.id);

    return { organization: org, agents };
  }

  @Get()
  findAll() {
    return this.organizationService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.organizationService.findOne(+id);
  }

  @Get(':id/users')
  findUsers(@Param('id') id: string) {
    return this.organizationService.findOrganizationUsers(+id);
  }

  @Get(':id/usage-stats')
  getUsageStats(
    @Param('id') id: string,
    @Query('period') period: 'today' | '30d' | '90d' = '30d',
  ) {
    return this.organizationService.getUsageStats(+id, period);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() updateOrganizationDto: UpdateOrganizationDto,
  ) {
    return this.organizationService.update(+id, updateOrganizationDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.organizationService.remove(+id);
  }
}
