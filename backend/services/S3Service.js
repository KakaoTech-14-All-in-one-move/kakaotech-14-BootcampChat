const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

class S3Service {
  constructor() {
    this.client = new S3Client({
      region: process.env.AWS_REGION || "ap-northeast-2",
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    });
    this.bucket = process.env.AWS_S3_BUCKET || "ktb-workshop";
  }

  async uploadFile(file, key) {
    try {
      const command = new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype,
        ContentDisposition: `inline; filename="${encodeURIComponent(
          file.originalname
        )}"`,
      });

      await this.client.send(command);

      return {
        success: true,
        key,
        url: await this.getSignedUrl(key),
      };
    } catch (error) {
      console.error("S3 upload error:", error);
      throw new Error("파일 업로드 중 오류가 발생했습니다.");
    }
  }

  async deleteFile(key) {
    try {
      const command = new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
      });

      await this.client.send(command);
      return { success: true };
    } catch (error) {
      console.error("S3 delete error:", error);
      throw new Error("파일 삭제 중 오류가 발생했습니다.");
    }
  }

  async getSignedUrl(key, expiresIn = 3600) {
    try {
      const command = new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      });

      const url = await getSignedUrl(this.client, command, { expiresIn });
      return url;
    } catch (error) {
      console.error("S3 signed URL error:", error);
      throw new Error("파일 URL 생성 중 오류가 발생했습니다.");
    }
  }

  generateKey(file, userId) {
    const timestamp = Date.now();
    const randomString = Math.random().toString(36).substring(2, 15);
    const ext = file.originalname.split(".").pop();
    return `uploads/${userId}/${timestamp}-${randomString}.${ext}`;
  }
}

module.exports = new S3Service();
