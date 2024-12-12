const bcrypt = require("bcryptjs");
const User = require("../models/User");
const { upload } = require("../middleware/upload");
const path = require("path");
const s3Service = require("../services/S3Service");

// 회원가입
exports.register = async (req, res) => {
  try {
    const { name, email, password } = req.body;

    // 입력값 검증
    const validationErrors = [];

    if (!name || name.trim().length === 0) {
      validationErrors.push({
        field: "name",
        message: "이름을 입력해주세요.",
      });
    } else if (name.length < 2) {
      validationErrors.push({
        field: "name",
        message: "이름은 2자 이상이어야 합니다.",
      });
    }

    if (!email) {
      validationErrors.push({
        field: "email",
        message: "이메일을 입력해주세요.",
      });
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      validationErrors.push({
        field: "email",
        message: "올바른 이메일 형식이 아닙니다.",
      });
    }

    if (!password) {
      validationErrors.push({
        field: "password",
        message: "비밀번호를 입력해주세요.",
      });
    } else if (password.length < 6) {
      validationErrors.push({
        field: "password",
        message: "비밀번호는 6자 이상이어야 합니다.",
      });
    }

    if (validationErrors.length > 0) {
      return res.status(400).json({
        success: false,
        errors: validationErrors,
      });
    }

    // 사용자 중복 확인
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(409).json({
        success: false,
        message: "이미 가입된 이메일입니다.",
      });
    }

    // 비밀번호 암호화 및 사용자 생성
    const newUser = new User({
      name,
      email,
      password,
      profileImage: "", // 기본 프로필 이미지 없음
    });

    const salt = await bcrypt.genSalt(10);
    newUser.password = await bcrypt.hash(password, salt);
    await newUser.save();

    res.status(201).json({
      success: true,
      message: "회원가입이 완료되었습니다.",
      user: {
        id: newUser._id,
        name: newUser.name,
        email: newUser.email,
        profileImage: newUser.profileImage,
      },
    });
  } catch (error) {
    console.error("Registration error:", error);
    res.status(500).json({
      success: false,
      message: "회원가입 처리 중 오류가 발생했습니다.",
    });
  }
};

// 프로필 조회
exports.getProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("-password");
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "사용자를 찾을 수 없습니다.",
      });
    }

    res.json({
      success: true,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        profileImage: user.profileImage,
      },
    });
  } catch (error) {
    console.error("Get profile error:", error);
    res.status(500).json({
      success: false,
      message: "프로필 조회 중 오류가 발생했습니다.",
    });
  }
};

// 프로필 업데이트
exports.updateProfile = async (req, res) => {
  try {
    const { name } = req.body;

    if (!name || name.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: "이름을 입력해주세요.",
      });
    }

    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "사용자를 찾을 수 없습니다.",
      });
    }

    user.name = name.trim();
    await user.save();

    res.json({
      success: true,
      message: "프로필이 업데이트되었습니다.",
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        profileImage: user.profileImage,
      },
    });
  } catch (error) {
    console.error("Update profile error:", error);
    res.status(500).json({
      success: false,
      message: "프로필 업데이트 중 오류가 발생했습니다.",
    });
  }
};

// 프로필 이미지 업로드
exports.uploadProfileImage = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "이미지가 제공되지 않았습니다.",
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

    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "사용자를 찾을 수 없습니다.",
      });
    }

    // 기존 프로필 이미지가 있다면 S3에서 삭제
    if (user.profileImage) {
      try {
        await s3Service.deleteFile(user.profileImage);
      } catch (error) {
        console.error("Old profile image delete error:", error);
      }
    }

    // S3에 새 이미지 업로드
    const key = s3Service.generateKey(req.file, user.id);
    const uploadResult = await s3Service.uploadFile(req.file, key);

    // 프로필 이미지 키 저장
    user.profileImage = key;
    await user.save();

    res.json({
      success: true,
      message: "프로필 이미지가 업데이트되었습니다.",
      imageUrl: uploadResult.url,
    });
  } catch (error) {
    console.error("Profile image upload error:", error);
    res.status(500).json({
      success: false,
      message: "이미지 업로드 중 오류가 발생했습니다.",
    });
  }
};

// 프로필 이미지 삭제
exports.deleteProfileImage = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "사용자를 찾을 수 없습니다.",
      });
    }

    if (user.profileImage) {
      await s3Service.deleteFile(user.profileImage);
      user.profileImage = "";
      await user.save();
    }

    res.json({
      success: true,
      message: "프로필 이미지가 삭제되었습니다.",
    });
  } catch (error) {
    console.error("Delete profile image error:", error);
    res.status(500).json({
      success: false,
      message: "프로필 이미지 삭제 중 오류가 발생했습니다.",
    });
  }
};

// 프로필 조회 (url 생성 로직 추가)
exports.getProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("-password");
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "사용자를 찾을 수 없습니다.",
      });
    }

    // 프로필 이미지가 있는 경우 서명된 URL 생성
    let imageUrl = "";
    if (user.profileImage) {
      imageUrl = await s3Service.getSignedUrl(user.profileImage);
    }

    res.json({
      success: true,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        profileImage: imageUrl,
      },
    });
  } catch (error) {
    console.error("Get profile error:", error);
    res.status(500).json({
      success: false,
      message: "프로필 조회 중 오류가 발생했습니다.",
    });
  }
};

// 회원 탈퇴
exports.deleteAccount = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "사용자를 찾을 수 없습니다.",
      });
    }

    // 프로필 이미지가 있다면 삭제
    if (user.profileImage) {
      const imagePath = path.join(__dirname, "..", user.profileImage);
      try {
        await fs.access(imagePath);
        await fs.unlink(imagePath);
      } catch (error) {
        console.error("Profile image delete error:", error);
      }
    }

    await user.deleteOne();

    res.json({
      success: true,
      message: "회원 탈퇴가 완료되었습니다.",
    });
  } catch (error) {
    console.error("Delete account error:", error);
    res.status(500).json({
      success: false,
      message: "회원 탈퇴 처리 중 오류가 발생했습니다.",
    });
  }
};

module.exports = exports;
