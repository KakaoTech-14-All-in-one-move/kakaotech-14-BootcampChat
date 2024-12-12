const mongoose = require("mongoose");

const FileSchema = new mongoose.Schema(
  {
    filename: {
      type: String,
      required: true,
      index: true,
      validate: {
        validator: function (v) {
          return /^[0-9]+_[a-f0-9]+\.[a-z0-9]+$/.test(v);
        },
        message: "올바르지 않은 파일명 형식입니다.",
      },
    },
    originalname: {
      type: String,
      required: true,
      set: function (name) {
        try {
          if (!name) return "";
          // 파일명에서 경로 구분자 제거
          const sanitizedName = name.replace(/[\/\\]/g, "");
          // 유니코드 정규화 (NFC)
          return sanitizedName.normalize("NFC");
        } catch (error) {
          console.error("Filename sanitization error:", error);
          return name;
        }
      },
      get: function (name) {
        try {
          if (!name) return "";
          return name.normalize("NFC");
        } catch (error) {
          console.error("Filename retrieval error:", error);
          return name;
        }
      },
    },
    mimetype: {
      type: String,
      required: true,
    },
    size: {
      type: Number,
      required: true,
      min: 0,
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    s3Key: {
      type: String,
      required: true,
      unique: true,
    },
    s3Url: {
      type: String,
      required: true,
    },
    uploadDate: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  {
    timestamps: true,
    toJSON: { getters: true },
    toObject: { getters: true },
  }
);

// 복합 인덱스 - S3Key를 포함하도록 변경
FileSchema.index({ s3Key: 1, user: 1 }, { unique: true });

// Content-Disposition 헤더를 위한 파일명 인코딩 메서드 (유지)
FileSchema.methods.getEncodedFilename = function () {
  try {
    const filename = this.originalname;
    if (!filename) return "";

    const encodedFilename = encodeURIComponent(filename)
      .replace(/'/g, "%27")
      .replace(/\(/g, "%28")
      .replace(/\)/g, "%29")
      .replace(/\*/g, "%2A");

    return {
      legacy: filename.replace(/[^\x20-\x7E]/g, ""),
      encoded: `UTF-8''${encodedFilename}`,
    };
  } catch (error) {
    console.error("Filename encoding error:", error);
    return {
      legacy: this.filename,
      encoded: this.filename,
    };
  }
};

// 파일 URL 생성 메서드 - S3 URL 반환하도록 수정
FileSchema.methods.getFileUrl = function () {
  return this.s3Url;
};

// 다운로드용 Content-Disposition 헤더 생성 메서드 (유지)
FileSchema.methods.getContentDisposition = function (type = "attachment") {
  const { legacy, encoded } = this.getEncodedFilename();
  return `${type}; filename="${legacy}"; filename*=${encoded}`;
};

// 파일 MIME 타입 검증 메서드 (유지)
FileSchema.methods.isPreviewable = function () {
  const previewableTypes = [
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    "video/mp4",
    "video/webm",
    "audio/mpeg",
    "audio/wav",
    "application/pdf",
  ];
  return previewableTypes.includes(this.mimetype);
};

// S3 관련 새로운 메서드 추가
FileSchema.methods.updateS3Info = function (s3Data) {
  this.s3Key = s3Data.key;
  this.s3Url = s3Data.url;
  return this.save();
};

// Presigned URL 확인 메서드 추가
FileSchema.methods.needsNewPresignedUrl = function () {
  // URL이 만료 예정인지 확인 (예: 1시간 이내)
  const urlExpirationTime = 3600; // 1시간
  const lastUpdate = new Date(this.updatedAt).getTime();
  const now = Date.now();

  return now - lastUpdate > urlExpirationTime * 1000;
};

module.exports = mongoose.model("File", FileSchema);
