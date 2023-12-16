import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';
import { TasksService } from 'src/task.service';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly taskService: TasksService,
    private schedulerRegistry: SchedulerRegistry,
  ) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Get('update-all-pages')
  async updateAllPages() {
    const job = new CronJob(`${30} * * * * *`, () => {
      this.taskService.updateAllPages();
    });
    this.schedulerRegistry.addCronJob('updateAllPages', job);
    job.start();

    setTimeout(() => {
      this.schedulerRegistry.deleteCronJob('updateAllPages');
    }, 40000);

    return 'Processing...';
  }
}
