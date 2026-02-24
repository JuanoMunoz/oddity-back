import { IsString, IsNumber, IsBoolean, IsOptional } from 'class-validator';

export class CreateIaModelDto {
    @IsString()
    name: string;

    @IsNumber()
    pricePerInputToken: number;

    @IsNumber()
    pricePerOutputToken: number;

    @IsBoolean()
    @IsOptional()
    isActive?: boolean;
}
