import { Type } from "class-transformer";
import { IsArray, IsString } from "class-validator";

export class History {
    @IsString()
    role: string;
    @IsString()
    text: string;
}
export class ChatGeminiDto {
    @IsArray()
    @Type(() => History)
    history: History[];
    @IsString()
    prompt: string;
}