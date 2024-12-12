// chatWorker.js
const { parentPort, workerData } = require("worker_threads");
const mongoose = require("mongoose");
const Message = require("../models/Message");
const User = require("../models/User");
const File = require("../models/File");
const redisClient = require("../utils/redisClient");
require("dotenv").config();

// 상수 정의
const BATCH_SIZE = 100;
const RETRY_LIMIT = 3;
const RETRY_DELAY = 1000;
const CACHE_TTL = 300;
const messageQueue = [];
let isProcessing = false;

// 이벤트 리스너 제한 증가
mongoose.connection.setMaxListeners(20);

// MongoDB 초기화 함수
async function initializeWorker() {
  try {
    // 기존 연결 종료
    if (mongoose.connection.readyState !== 0) {
      await mongoose.connection.close();
    }

    // 새로운 연결 생성
    await mongoose.connect(process.env.MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 15000,
      socketTimeoutMS: 45000,
      connectTimeoutMS: 15000,
      family: 4, // IPv4 사용 강제
    });

    console.log(`Worker ${workerData?.workerId}: MongoDB Connected`);

    // 이벤트 리스너 등록 전 기존 리스너 제거
    mongoose.connection.removeAllListeners("error");
    mongoose.connection.removeAllListeners("disconnected");

    mongoose.connection.on("error", async (err) => {
      console.error(
        `Worker ${workerData?.workerId} MongoDB connection error:`,
        err
      );
      await reconnectWithBackoff();
    });

    mongoose.connection.on("disconnected", async () => {
      console.log(`Worker ${workerData?.workerId}: MongoDB disconnected`);
      await reconnectWithBackoff();
    });

    return true;
  } catch (error) {
    console.error(
      `Worker ${workerData?.workerId} MongoDB initialization error:`,
      error
    );
    throw error;
  }
}

// 재연결 백오프 함수
async function reconnectWithBackoff(attempt = 1, maxAttempts = 5) {
  const backoffMs = Math.min(1000 * Math.pow(2, attempt), 10000);

  if (attempt > maxAttempts) {
    console.error("Max reconnection attempts reached");
    process.exit(1);
  }

  await new Promise((resolve) => setTimeout(resolve, backoffMs));

  try {
    await initializeWorker();
  } catch (error) {
    console.error(`Reconnection attempt ${attempt} failed:`, error);
    await reconnectWithBackoff(attempt + 1, maxAttempts);
  }
}

// 메시지 처리 함수
async function processMessage(data) {
  try {
    const { type, payload } = data;

    switch (type) {
      case "SAVE_MESSAGE":
        return await handleSaveMessage(payload);
      case "LOAD_MESSAGES":
        return await handleLoadMessages(payload);
      case "UPDATE_CACHE":
        return await handleUpdateCache(payload);
      case "UPDATE_READ_STATUS":
        return await handleReadStatus(payload);
      default:
        throw new Error(`Unknown message type: ${type}`);
    }
  } catch (error) {
    console.error("Worker processing error:", error);
    return { error: error.message };
  }
}

// 메시지 저장 처리
async function handleSaveMessage(payload) {
  const { message, room } = payload;
  let retryCount = 0;

  while (retryCount < RETRY_LIMIT) {
    try {
      const savedMessage = await Message.create(message);
      await savedMessage.populate([
        { path: "sender", select: "name email profileImage" },
        { path: "file", select: "filename originalname mimetype size" },
      ]);

      // Redis 캐시 업데이트
      try {
        const redisKey = `room:${room}:messages`;
        const cachedMessages = (await redisClient.get(redisKey)) || [];

        if (Array.isArray(cachedMessages)) {
          cachedMessages.unshift(savedMessage);
          await redisClient.set(
            redisKey,
            cachedMessages.slice(0, 100),
            "EX",
            CACHE_TTL
          );
        } else {
          await redisClient.set(redisKey, [savedMessage], "EX", CACHE_TTL);
        }
      } catch (redisError) {
        console.error("Redis cache update error:", redisError);
      }

      return { success: true, message: savedMessage };
    } catch (error) {
      retryCount++;
      console.error(`Save attempt ${retryCount} failed:`, error);

      if (retryCount === RETRY_LIMIT) {
        throw new Error(
          `Message save failed after ${RETRY_LIMIT} attempts: ${error.message}`
        );
      }

      await new Promise((resolve) =>
        setTimeout(resolve, RETRY_DELAY * retryCount)
      );
      await initializeWorker();
    }
  }
}

// 메시지 로드 처리
async function handleLoadMessages(payload) {
  const { roomId, before, limit } = payload;
  let retryCount = 0;

  while (retryCount < RETRY_LIMIT) {
    try {
      const redisKey = `room:${roomId}:messages`;
      let messages = await redisClient.get(redisKey);
      let fromCache = false;

      if (messages) {
        fromCache = true;
        if (before) {
          messages = messages.filter(
            (msg) => new Date(msg.timestamp) < new Date(before)
          );
        }
      } else {
        const query = before
          ? { room: roomId, timestamp: { $lt: new Date(before) } }
          : { room: roomId };

        messages = await Message.find(query)
          .populate("sender", "name email profileImage")
          .populate("file", "filename originalname mimetype size")
          .sort({ timestamp: -1 })
          .limit(limit + 1)
          .lean()
          .maxTimeMS(20000);

        if (messages.length > 0) {
          await redisClient.set(redisKey, messages, "EX", CACHE_TTL);
        }
      }

      const hasMore = messages.length > limit;
      const resultMessages = messages.slice(0, limit);
      const sortedMessages = resultMessages.sort(
        (a, b) => new Date(a.timestamp) - new Date(b.timestamp)
      );

      return {
        success: true,
        messages: sortedMessages,
        hasMore,
        oldestTimestamp: sortedMessages[0]?.timestamp || null,
        fromCache,
      };
    } catch (error) {
      retryCount++;
      if (retryCount === RETRY_LIMIT) {
        throw new Error(`Message load failed: ${error.message}`);
      }
      await new Promise((resolve) =>
        setTimeout(resolve, RETRY_DELAY * retryCount)
      );
      await initializeWorker();
    }
  }
}

// 캐시 업데이트 처리
async function handleUpdateCache(payload) {
  const { roomId, messages } = payload;
  let retryCount = 0;

  while (retryCount < RETRY_LIMIT) {
    try {
      const redisKey = `room:${roomId}:messages`;
      await redisClient.set(redisKey, messages, "EX", CACHE_TTL);
      return { success: true };
    } catch (error) {
      retryCount++;
      if (retryCount === RETRY_LIMIT) {
        throw new Error(`Cache update failed: ${error.message}`);
      }
      await new Promise((resolve) =>
        setTimeout(resolve, RETRY_DELAY * retryCount)
      );
    }
  }
}

// 읽음 상태 업데이트 처리
async function handleReadStatus(payload) {
  const { messageIds, userId, roomId } = payload;
  let retryCount = 0;

  while (retryCount < RETRY_LIMIT) {
    try {
      const messageChunks = [];
      for (let i = 0; i < messageIds.length; i += BATCH_SIZE) {
        messageChunks.push(messageIds.slice(i, i + BATCH_SIZE));
      }

      for (const chunk of messageChunks) {
        await Message.bulkWrite(
          chunk.map((messageId) => ({
            updateOne: {
              filter: {
                _id: messageId,
                room: roomId,
                "readers.userId": { $ne: userId },
              },
              update: {
                $push: {
                  readers: {
                    userId,
                    readAt: new Date(),
                  },
                },
              },
            },
          })),
          { ordered: false }
        );
      }

      // Redis 캐시 업데이트
      try {
        const redisKey = `room:${roomId}:messages`;
        const cachedMessages = await redisClient.get(redisKey);

        if (cachedMessages && Array.isArray(cachedMessages)) {
          const updatedMessages = cachedMessages.map((msg) => {
            if (messageIds.includes(msg._id.toString())) {
              const readers = msg.readers || [];
              if (!readers.some((r) => r.userId.toString() === userId)) {
                readers.push({ userId, readAt: new Date() });
              }
              return { ...msg, readers };
            }
            return msg;
          });

          await redisClient.set(redisKey, updatedMessages, "EX", CACHE_TTL);
        }
      } catch (redisError) {
        console.error("Redis cache update error:", redisError);
      }

      return { success: true };
    } catch (error) {
      retryCount++;
      if (retryCount === RETRY_LIMIT) {
        throw new Error(`Read status update failed: ${error.message}`);
      }
      await new Promise((resolve) =>
        setTimeout(resolve, RETRY_DELAY * retryCount)
      );
      await initializeWorker();
    }
  }
}

// Worker 초기화 및 메시지 수신 처리
initializeWorker()
  .then(() => {
    console.log(`Worker ${workerData?.workerId} initialized successfully`);

    parentPort.on("message", (message) => {
      messageQueue.push(message);
      if (!isProcessing) {
        processMessageQueue();
      }
    });
  })
  .catch((error) => {
    console.error("Worker initialization failed:", error);
    process.exit(1);
  });

// 메시지 큐 처리 함수
async function processMessageQueue() {
  if (isProcessing || messageQueue.length === 0) return;

  isProcessing = true;
  const currentMessage = messageQueue.shift();

  try {
    if (!currentMessage || !currentMessage.data) {
      throw new Error("Invalid message format");
    }

    const result = await processMessage(currentMessage.data);
    parentPort.postMessage({
      id: currentMessage.id,
      result,
    });
  } catch (error) {
    console.error("Queue processing error:", error);
    parentPort.postMessage({
      id: currentMessage.id,
      error: error.message || "Unknown error occurred",
    });
  } finally {
    isProcessing = false;
    if (messageQueue.length > 0) {
      setImmediate(processMessageQueue);
    }
  }
}

// 종료 처리
process.on("SIGTERM", async () => {
  try {
    await mongoose.connection.close();
    process.exit(0);
  } catch (error) {
    console.error("Worker shutdown error:", error);
    process.exit(1);
  }
});
