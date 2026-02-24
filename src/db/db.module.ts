import { Module, Global } from '@nestjs/common';
import { db } from './index';

export const DRIZZLE = 'DRIZZLE';

@Global()
@Module({
    providers: [
        {
            provide: DRIZZLE,
            useValue: db,
        },
    ],
    exports: [DRIZZLE],
})
export class DbModule { }
