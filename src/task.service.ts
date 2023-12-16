import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { RateLimit } from 'async-sema';
import { AxiosError } from 'axios';
import { createHash } from 'crypto';
import { imageSize } from 'image-size';
import { catchError, firstValueFrom } from 'rxjs';
import { S3Service } from 'src/s3.service';
import { EXTENSIONS_TO_CONVERT_TO_WEBP, RETRY_TIMES } from 'src/utils/constant';
import { getMimeType } from 'src/utils/file';

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

  private readonly rateLimiter = RateLimit(1, {
    timeUnit: 2000,
    uniformDistribution: true,
  });

  async getPagesByDatabaseId(id: string) {
    let pages = [];
    let hasMore = true;
    let startCursor = null;

    while (hasMore) {
      await this.rateLimiter();
      const bodyParams = startCursor
        ? { page_size: 100, start_cursor: startCursor }
        : { page_size: 100 };

      const { data } = await firstValueFrom(
        this.httpService
          .post(
            `/databases/${id}/query`,
            {
              ...bodyParams,
              filter: {
                and: [
                  {
                    property: 'is_published',
                    checkbox: {
                      equals: true,
                    },
                  },
                  {
                    property: 'is_updated',
                    checkbox: {
                      equals: false,
                    },
                  },
                ],
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

      pages = [...pages, ...data.results];
      hasMore = data.has_more;
      startCursor = data.next_cursor;
    }

    return pages;
  }

  async getBlocksByPageId(id) {
    let blocks = [];
    let hasMore = true;
    let startCursor = null;

    while (hasMore) {
      let queryParams = 'page_size=100';
      if (startCursor) {
        queryParams += `&start_cursor=${startCursor}`;
      }

      const { data } = await firstValueFrom(
        this.httpService
          .get(`/blocks/${id}/children?${queryParams}`, {
            baseURL: this.notionBaseUrl,
            headers: {
              Authorization: `Bearer ${this.notionKey}`,
              'Notion-Version': this.notionVersion,
            },
          })
          .pipe(
            catchError((error: AxiosError) => {
              this.logger.error('Failed at getBlocksByPageId');
              throw error.response.data;
            }),
          ),
      );

      blocks = [...blocks, ...data.results];
      hasMore = data.has_more;
      startCursor = data.next_cursor;
    }

    return blocks;
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
            this.logger.error('Failed at appendBlockChildren');
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

        const mimeType = getMimeType(imageInfo.type);
        const shouldConvert = EXTENSIONS_TO_CONVERT_TO_WEBP.includes(
          imageInfo.type,
        );
        const fileName = shouldConvert
          ? `${hash}.webp`
          : `${hash}.${imageInfo.type}`;
        await this.s3Service.uploadObject(
          fileName,
          buff,
          shouldConvert ? 'image/webp' : mimeType,
        );

        return { fileName, imageInfo };
      } catch (error) {
        retryCount++;
        this.logger.error(`Failed at upload image to S3: ${retryCount} times`);
        this.logger.error(error);
      }
    }
    // failed to upload image
    return {};
  }

  async deleteBlockById(id) {
    const { data } = await firstValueFrom(
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
            this.logger.error('Failed at deleteBlockById');
            throw error.response.data;
          }),
        ),
    );

    return data;
  }

  async markPageAsUpdated(pageId) {
    const { data } = await firstValueFrom(
      this.httpService
        .patch(
          `/pages/${pageId}`,
          {
            properties: {
              is_updated: { checkbox: true },
            },
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
            this.logger.error('Failed at markPageAsUpdated');
            throw error.response.data;
          }),
        ),
    );

    return data;
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
              url: `${this.imageDomain}/${fileName}?w=${
                imageInfo?.width ?? 0
              }&h=${imageInfo?.height ?? 0}`,
            },
          },
        });
      }

      // delete all blocks
      await Promise.all(
        blocks.map(async (block) => {
          await this.rateLimiter();
          return this.deleteBlockById(block.id);
        }),
      );

      // append new blocks
      const updatedBlocksChunks = [];
      while (updatedBlocks.length > 0) {
        updatedBlocksChunks.push(updatedBlocks.splice(0, 100));
      }
      for (const blocksChunk of updatedBlocksChunks) {
        await this.rateLimiter();
        await this.appendBlockChildren(page.id, blocksChunk);
      }

      await this.markPageAsUpdated(page.id);

      this.logger.log(
        `Finish updating for page: ${
          page.properties.title.title?.[0]?.plain_text ?? page.id
        }!`,
      );
    } catch (error) {
      this.logger.error('Failed at updateBlocksByPage');
      this.logger.error(error);
    }
  }

  async updateAllPages() {
    try {
      const pages = await this.getPagesByDatabaseId(this.notionDatabaseId);
      await Promise.all(
        pages.map(async (page) => {
          await this.rateLimiter();
          return this.updateBlocksOfPage(page);
        }),
      );
      this.logger.log('Finish updating for all pages!');
    } catch (error) {
      this.logger.error('Failed at handleCron');
      this.logger.error(error);
    }
  }

  @Cron(CronExpression.EVERY_DAY_AT_2AM, {
    name: 'updateAllPages',
  })
  async handleCron() {
    try {
      const pages = await this.getPagesByDatabaseId(this.notionDatabaseId);
      await Promise.all(
        pages.map(async (page) => {
          await this.rateLimiter();
          return this.updateBlocksOfPage(page);
        }),
      );
      this.logger.log('Finish updating for all pages!');
    } catch (error) {
      this.logger.error('Failed at handleCron');
      this.logger.error(error);
    }
  }
}
