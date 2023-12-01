import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AxiosError } from 'axios';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { catchError, firstValueFrom } from 'rxjs';

@Injectable()
export class TasksService {
  constructor(
    private configService: ConfigService,
    private readonly httpService: HttpService,
  ) {}

  private readonly logger = new Logger(TasksService.name);
  // notion
  private readonly notionBaseUrl =
    this.configService.get<string>('NOTION_BASE_URL');
  private readonly notionKey = this.configService.get<string>('NOTION_KEY');
  private readonly notionVersion =
    this.configService.get<string>('NOTION_VERSION');
  private readonly notionDatabaseId =
    this.configService.get<string>('NOTION_DATABASE_ID');

  async getPagesByDatabaseId(id: string) {
    const { data } = await firstValueFrom(
      this.httpService
        .post(
          `/databases/${id}/query`,
          {
            filter: {
              property: 'is_published',
              checkbox: {
                equals: true,
              },
            },
            sorts: [
              {
                property: 'published_at',
                direction: 'descending',
              },
            ],
          },
          {
            baseURL: this.notionBaseUrl,
            headers: {
              Authorization: `Bearer ${this.notionKey}`,
              'Notion-Version': this.notionVersion,
              'Content-Type': 'application/json',
            },
          },
        )
        .pipe(
          catchError((error: AxiosError) => {
            this.logger.error(error);
            throw 'An error happened!';
          }),
        ),
    );
    return data;
  }

  async getBlocksByPageId(id) {
    const { data } = await firstValueFrom(
      this.httpService
        .get(`/blocks/${id}/children?page_size=100`, {
          baseURL: this.notionBaseUrl,
          headers: {
            Authorization: `Bearer ${this.notionKey}`,
            'Notion-Version': this.notionVersion,
          },
        })
        .pipe(
          catchError((error: AxiosError) => {
            this.logger.error(error);
            throw 'An error happened!';
          }),
        ),
    );

    return data;
  }

  downloadImage = async (url: string) => {
    const { data } = await firstValueFrom(
      this.httpService.get(url, { responseType: 'arraybuffer' }).pipe(
        catchError((error: AxiosError) => {
          this.logger.error(error);
          throw 'An error happened!';
        }),
      ),
    );
    return data;
  };

  writeImage = async ({
    fileName,
    content,
  }: {
    fileName: string;
    content: string;
  }) => {
    try {
      const filePath = path.join(__dirname, '..', 'public', fileName);
      fs.writeFileSync(filePath, content);
    } catch (error) {
      this.logger.error(error);
    }
  };

  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async handleCron() {
    const response = await this.getPagesByDatabaseId(this.notionDatabaseId);
    const pageIds = response.results.map((page) => page.id);
    for (const pageId of pageIds) {
      const response = await this.getBlocksByPageId(pageId);
      const imageBlocks = (response.results ?? []).filter(
        (block) => block.type === 'image',
      );
      for (const imageBlock of imageBlocks) {
        const imageUrl =
          imageBlock.image.file?.url ?? imageBlock.image.external?.url;
        if (!imageUrl) continue;
        const buff = await this.downloadImage(imageUrl);
        const hash = createHash('md5').update(buff).digest('hex');
        await this.writeImage({ fileName: `${hash}.webp`, content: buff });
        // TODO: update the new image to notion block
      }
      this.logger.log(`Write image for page ${pageId} done!`);
    }
  }
}

@Injectable()
export class AppService {
  getHello(): string {
    return 'Hello World!';
  }
}
