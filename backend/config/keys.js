// backend/config/keys.js
require('dotenv').config();

// 기본 키와 솔트 (개발 환경용)
const DEFAULT_ENCRYPTION_KEY = 'a'.repeat(64); // 32바이트를 hex로 표현
const DEFAULT_PASSWORD_SALT = 'b'.repeat(32); // 16바이트를 hex로 표현

module.exports = {
  // Sentinel 1
  sentinelHost1: process.env.SENTINEL_HOST1,
  sentinelPort1: process.env.SENTINEL_PORT1 || 26379,

  // Sentinel 2
  sentinelHost2: process.env.SENTINEL_HOST2,
  sentinelPort2: process.env.SENTINEL_PORT2 || 26379,

  // Sentinel 3
  sentinelHost3: process.env.SENTINEL_HOST3,
  sentinelPort3: process.env.SENTINEL_PORT3 || 26379,

  mongoURI: process.env.MONGO_URI,
  jwtSecret: process.env.JWT_SECRET,
  encryptionKey: process.env.ENCRYPTION_KEY || DEFAULT_ENCRYPTION_KEY,
  passwordSalt: process.env.PASSWORD_SALT || DEFAULT_PASSWORD_SALT,
  redisHost: process.env.REDIS_HOST,
  redisPort: process.env.REDIS_PORT,
  openaiApiKey: process.env.OPENAI_API_KEY,
  vectorDbEndpoint: process.env.VECTOR_DB_ENDPOINT,
};