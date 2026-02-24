import {
    IsString,
    IsNumber,
    IsOptional,
    IsBoolean,
    IsEmail
} from "class-validator";
import { Type } from "class-transformer";

export class CreateOrganizationDto {

    @IsString()
    name: string;

    @IsString()
    accessToken: string;

    @IsEmail()
    billingEmail: string;

    @Type(() => Number)
    @IsNumber()
    monthlySpendingLimit: number;

    @IsString()
    slug: string;

    @IsString()
    logo: string;

    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    currentSpent?: number;

    @IsBoolean()
    isActive: boolean;
}