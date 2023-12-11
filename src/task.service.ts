import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AxiosError } from 'axios';
import { createHash } from 'crypto';
import { imageSize } from 'image-size';
import { catchError, firstValueFrom } from 'rxjs';
import { S3Service } from 'src/s3.service';
import { EXTENSIONS_TO_CONVERT_TO_WEBP, RETRY_TIMES } from 'src/utils/constant';

@Injectable()
export class TasksService {
  constructor(
    private configService: ConfigService,
    private readonly httpService: HttpService,
    private readonly s3Service: S3Service,
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
  // s3
  private readonly imageDomain = this.configService.get<string>('IMAGE_DOMAIN');

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
    let retryCount = 0;
    while (retryCount < RETRY_TIMES) {
      try {
        const imageUrl = block.image.file?.url ?? block.image.external?.url;
        if (!imageUrl) return;
        const buff = await this.downloadImage(imageUrl);
        const hash = createHash('md5').update(buff).digest('hex');
        const imageInfo = imageSize(buff);
        const fileName = EXTENSIONS_TO_CONVERT_TO_WEBP.includes(imageInfo.type)
          ? `${hash}.webp`
          : `${hash}.${imageInfo.type}`;
        await this.s3Service.uploadObject(fileName, buff);

        return { fileName, imageInfo };
      } catch (error) {
        retryCount++;
        this.logger.error(`Failed at upload image to S3: ${retryCount} times`);
      }
    }
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

  async updateBlocksOfPage(page: any) {
    try {
      const blocks = await this.getBlocksByPageId(page.id);
      const updatedBlocks = [];
      for (const block of blocks) {
        if (block.type !== 'image') {
          const newBlock = this.removeUnnecessaryBlockInfo({ ...block });
          updatedBlocks.push(newBlock);
          continue;
        }
        const { fileName, imageInfo } = await this.handleImageBlock(block);
        updatedBlocks.push({
          object: 'block',
          type: 'image',
          image: {
            caption: block.image.caption,
            type: 'external',
            external: {
              url: `${this.imageDomain}/${fileName}?w=${imageInfo.width}&h=${imageInfo.height}`,
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
      this.logger.error('Failed at updateBlocksByPageId');
      this.logger.error(error);
    }
  }

  @Cron(CronExpression.EVERY_30_SECONDS)
  async handleCron() {
    const pages = await this.getPagesByDatabaseId(this.notionDatabaseId);
    const promises = [];
    for (const page of pages) {
      promises.push(this.updateBlocksOfPage(page));
    }
    await Promise.all(promises);
    this.logger.log('Finish updating for all pages!');
  }
}
