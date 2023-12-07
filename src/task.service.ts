import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AxiosError } from 'axios';
import { createHash } from 'crypto';
import * as fs from 'fs';
import { imageSize } from 'image-size';
import * as path from 'path';
import { catchError, firstValueFrom } from 'rxjs';
import { EXTENSIONS_TO_CONVERT_TO_WEBP } from 'src/utils/constant';

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
  private readonly notionDatabaseId = this.configService.get<string>(
    'NOTION_DATABASE_DEV_ID',
  );
  private readonly serverUrl = this.configService.get<string>('SERVER_URL');

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
            throw error.response.data;
          }),
        ),
    );
    return data.results ?? [];
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
            throw error.response.data;
          }),
        ),
    );

    return data.results ?? [];
  }

  async appendBlockChildren(pageId, data) {
    const { data: appendedBlocks } = await firstValueFrom(
      this.httpService
        .patch(
          `/blocks/${pageId}/children`,
          {
            children: data,
          },
          {
            baseURL: this.notionBaseUrl,
            headers: {
              Authorization: `Bearer ${this.notionKey}`,
              'Notion-Version': this.notionVersion,
            },
          },
        )
        .pipe(
          catchError((error: AxiosError) => {
            throw error.response.data;
          }),
        ),
    );

    return appendedBlocks;
  }

  async downloadImage(url: string) {
    const { data } = await firstValueFrom(
      this.httpService.get(url, { responseType: 'arraybuffer' }).pipe(
        catchError((error: AxiosError) => {
          throw error.response.data;
        }),
      ),
    );
    return data;
  }

  async writeImage({
    fileName,
    content,
  }: {
    fileName: string;
    content: string;
  }) {
    try {
      const filePath = path.resolve(process.cwd(), 'public', fileName);
      fs.writeFileSync(filePath, content);
    } catch (error) {
      throw error.response.data;
    }
  }

  removeUnnecessaryBlockInfo(block) {
    delete block.id;
    delete block.parent;
    delete block.created_time;
    delete block.last_edited_time;
    delete block.last_edited_by;
    delete block.has_children;
    delete block.archived;
    delete block.created_by;

    return block;
  }

  async handleImageBlock(block) {
    const imageUrl = block.image.file?.url ?? block.image.external?.url;
    if (!imageUrl) return;
    const buff = await this.downloadImage(imageUrl);
    const hash = createHash('md5').update(buff).digest('hex');
    const imageInfo = imageSize(buff);
    const fileName = EXTENSIONS_TO_CONVERT_TO_WEBP.includes(imageInfo.type)
      ? `${hash}.webp`
      : `${hash}.${imageInfo.type}`;
    await this.writeImage({ fileName, content: buff });

    return fileName;
  }

  async deleteBlockById(id) {
    firstValueFrom(
      this.httpService
        .delete(`/blocks/${id}`, {
          baseURL: this.notionBaseUrl,
          headers: {
            Authorization: `Bearer ${this.notionKey}`,
            'Notion-Version': this.notionVersion,
          },
        })
        .pipe(
          catchError((error: AxiosError) => {
            throw error.response.data;
          }),
        ),
    );
  }

  @Cron(CronExpression.EVERY_30_SECONDS)
  async handleCron() {
    const pages = await this.getPagesByDatabaseId(this.notionDatabaseId);
    for (const page of pages) {
      try {
        const blocks = await this.getBlocksByPageId(page.id);
        const updatedBlocks = [];
        for (const block of blocks) {
          if (block.type !== 'image') {
            const newBlock = this.removeUnnecessaryBlockInfo({ ...block });
            updatedBlocks.push(newBlock);
            continue;
          }
          const fileName = await this.handleImageBlock(block);
          updatedBlocks.push({
            object: 'block',
            type: 'image',
            image: {
              caption: block.image.caption,
              type: 'external',
              external: {
                url: `${this.serverUrl}/${fileName}`,
              },
            },
          });
          await this.deleteBlockById(block.id);
        }

        await this.appendBlockChildren(page.id, updatedBlocks);
        this.logger.log(
          `Finish updating for page: ${
            page.properties.title.title?.[0]?.plain_text ?? page.id
          }!`,
        );
      } catch (error) {
        this.logger.error(error);
      }
    }
    this.logger.log('Finish updating for all pages!');
  }
}
