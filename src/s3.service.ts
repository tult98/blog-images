import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class S3Service {
  private readonly bucket = this.configService.get<string>('BUCKET');
  private readonly logger = new Logger(S3Service.name);
  private readonly s3Client = new S3Client({
    region: this.configService.get<string>('REGION'),
    credentials: {
      accessKeyId: this.configService.get<string>('ACCESS_KEY'),
      secretAccessKey: this.configService.get<string>('SECRET_KEY'),
    },
  });

  constructor(private configService: ConfigService) {}

  async uploadObject(fileName: string, body: any, mimeType: string) {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: fileName,
      Body: body,
      ContentType: mimeType,
    });

    try {
      await this.s3Client.send(command);
      this.logger.log(`Upload success: ${fileName}`);
    } catch (error) {
      this.logger.error('Failed at upload objet to S3');
      throw error;
    }
  }
}
