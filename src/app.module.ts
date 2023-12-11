import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { S3Service } from 'src/s3.service';
import { TasksService } from 'src/task.service';
import { AppController } from './app.controller';
import { AppService } from './app.service';

@Module({
  imports: [ConfigModule.forRoot(), ScheduleModule.forRoot(), HttpModule],
  controllers: [AppController],
  providers: [AppService, TasksService, S3Service],
})
export class AppModule {}
