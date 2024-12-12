const File = require("../models/File");
const Message = require("../models/Message");
const Room = require("../models/Room");
const { processFileForRAG } = require("../services/fileService");
const path = require("path");
const fs = require("fs");
const { promisify } = require("util");
const crypto = require("crypto");
const { uploadDir } = require("../middleware/upload");
const s3Service = require("../services/S3Service");

const fsPromises = {
  writeFile: promisify(fs.writeFile),
  unlink: promisify(fs.unlink),
  access: promisify(fs.access),
  mkdir: promisify(fs.mkdir),
  rename: promisify(fs.rename),
};

const isPathSafe = (filepath, directory) => {
  const resolvedPath = path.resolve(filepath);
  const resolvedDirectory = path.resolve(directory);
  return resolvedPath.startsWith(resolvedDirectory);
};

const generateSafeFilename = (originalFilename) => {
  const ext = path.extname(originalFilename || "").toLowerCase();
  const timestamp = Date.now();
  const randomBytes = crypto.randomBytes(8).toString("hex");
  return `${timestamp}_${randomBytes}${ext}`;
};

// 개선된 파일 정보 조회 함수
const getFileFromRequest = async (req) => {
  try {
    const filename = req.params.filename;
    const token = req.headers["x-auth-token"] || req.query.token;
    const sessionId = req.headers["x-session-id"] || req.query.sessionId;

    if (!filename) {
      throw new Error("Invalid filename");
    }

    if (!token || !sessionId) {
      throw new Error("Authentication required");
    }

    // 파일 정보 조회
    const file = await File.findOne({ filename: filename });
    if (!file) {
      throw new Error("File not found in database");
    }

    // 채팅방 권한 검증을 위한 메시지 조회
    const message = await Message.findOne({ file: file._id });
    if (!message) {
      throw new Error("File message not found");
    }

    // 사용자가 해당 채팅방의 참가자인지 확인
    const room = await Room.findOne({
      _id: message.room,
      participants: req.user.id,
    });

    if (!room) {
      throw new Error("Unauthorized access");
    }

    // S3 URL이 만료되었거나 없는 경우 새로 생성
    if (!file.s3Url || file.needsNewPresignedUrl()) {
      const newUrl = await s3Service.getSignedUrl(file.s3Key);
      file.s3Url = newUrl;
      await file.save();
    }

    return { file };
  } catch (error) {
    console.error("getFileFromRequest error:", {
      filename: req.params.filename,
      error: error.message,
    });
    throw error;
  }
};

exports.uploadFile = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "파일이 제공되지 않았습니다.",
      });
    }

    // 파일 유효성 검사
    const fileSize = req.file.size;
    const fileType = req.file.mimetype;
    const maxSize = 5 * 1024 * 1024; // 5MB

    if (fileSize > maxSize) {
      return res.status(400).json({
        success: false,
        message: "파일 크기는 5MB를 초과할 수 없습니다.",
      });
    }

    if (!fileType.startsWith("image/")) {
      return res.status(400).json({
        success: false,
        message: "이미지 파일만 업로드할 수 있습니다.",
      });
    }

    // 안전한 파일명 생성
    const timestamp = Date.now();
    const randomString = crypto.randomBytes(8).toString("hex");
    const ext = path.extname(req.file.originalname).toLowerCase();
    const safeFilename = `${timestamp}_${randomString}${ext}`;

    // S3에 파일 업로드
    const key = s3Service.generateKey(req.file, req.user.id);
    const uploadResult = await s3Service.uploadFile(
      {
        buffer: req.file.buffer,
        mimetype: req.file.mimetype,
        originalname: req.file.originalname,
      },
      key
    );

    // DB에 파일 정보 저장
    const file = new File({
      filename: safeFilename, // 필수 필드 추가
      user: req.user.id,
      originalname: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
      s3Key: uploadResult.key,
      s3Url: uploadResult.url,
    });

    await file.save();

    res.status(201).json({
      success: true,
      file: {
        _id: file._id,
        filename: file.filename,
        originalname: file.originalname,
        mimetype: file.mimetype,
        size: file.size,
        url: file.s3Url,
      },
    });
  } catch (error) {
    console.error("File upload error:", error);
    res.status(500).json({
      success: false,
      message: "파일 업로드 중 오류가 발생했습니다.",
    });
  }
};

exports.downloadFile = async (req, res) => {
  try {
    const { file } = await getFileFromRequest(req);

    // Content-Disposition 헤더 설정
    const contentDisposition = file.getContentDisposition("attachment");

    // S3 URL로 리다이렉트하되, 다운로드 헤더 추가
    res.setHeader("Content-Disposition", contentDisposition);
    res.redirect(file.s3Url);
  } catch (error) {
    handleFileError(error, res);
  }
};

exports.viewFile = async (req, res) => {
  try {
    const { file } = await getFileFromRequest(req);

    if (!file.isPreviewable()) {
      return res.status(415).json({
        success: false,
        message: "미리보기를 지원하지 않는 파일 형식입니다.",
      });
    }

    // S3 파일로 리다이렉트
    res.redirect(file.s3Url);
  } catch (error) {
    handleFileError(error, res);
  }
};

const handleFileStream = (fileStream, res) => {
  fileStream.on("error", (error) => {
    console.error("File streaming error:", error);
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        message: "파일 스트리밍 중 오류가 발생했습니다.",
      });
    }
  });

  fileStream.pipe(res);
};

const handleFileError = (error, res) => {
  console.error("File operation error:", {
    message: error.message,
    stack: error.stack,
  });

  // 에러 상태 코드 및 메시지 매핑
  const errorResponses = {
    "Invalid filename": { status: 400, message: "잘못된 파일명입니다." },
    "Authentication required": { status: 401, message: "인증이 필요합니다." },
    "Invalid file path": { status: 400, message: "잘못된 파일 경로입니다." },
    "File not found in database": {
      status: 404,
      message: "파일을 찾을 수 없습니다.",
    },
    "File message not found": {
      status: 404,
      message: "파일 메시지를 찾을 수 없습니다.",
    },
    "Unauthorized access": {
      status: 403,
      message: "파일에 접근할 권한이 없습니다.",
    },
    ENOENT: { status: 404, message: "파일을 찾을 수 없습니다." },
  };

  const errorResponse = errorResponses[error.message] || {
    status: 500,
    message: "파일 처리 중 오류가 발생했습니다.",
  };

  res.status(errorResponse.status).json({
    success: false,
    message: errorResponse.message,
  });
};

exports.deleteFile = async (req, res) => {
  try {
    const file = await File.findById(req.params.id);

    if (!file) {
      return res.status(404).json({
        success: false,
        message: "파일을 찾을 수 없습니다.",
      });
    }

    if (file.user.toString() !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: "파일을 삭제할 권한이 없습니다.",
      });
    }

    // S3에서 파일 삭제
    if (file.s3Key) {
      await s3Service.deleteFile(file.s3Key);
    }

    await file.deleteOne();

    res.json({
      success: true,
      message: "파일이 삭제되었습니다.",
    });
  } catch (error) {
    console.error("File deletion error:", error);
    res.status(500).json({
      success: false,
      message: "파일 삭제 중 오류가 발생했습니다.",
      error: error.message,
    });
  }
};
