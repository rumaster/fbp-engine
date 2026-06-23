import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AdminController } from './admin/admin.controller';
import { AdminDataService } from './admin/admin-data.service';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { AdminAuthGuard } from './auth/admin-auth.guard';
import { adminApiEnvFilePaths } from './config/env-files';
import { DatabaseModule } from './database/database.module';
import { EmbeddingService } from './embedding/embedding.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: adminApiEnvFilePaths(),
    }),
    DatabaseModule,
  ],
  controllers: [AuthController, AdminController],
  providers: [AuthService, AdminAuthGuard, AdminDataService, EmbeddingService],
})
export class AppModule {}
