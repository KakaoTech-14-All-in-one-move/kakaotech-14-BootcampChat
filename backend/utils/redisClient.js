const Redis = require("redis");
const {
    sentinelHost1,
    sentinelPort1,
    sentinelHost2,
    sentinelPort2,
    sentinelHost3,
    sentinelPort3,
    redisMasterName,
    sentinelPassword,
    redisPassword
} = require("../config/keys");

class RedisClient {
    constructor() {
        this.client = null;
        this.isConnected = false;
        this.connectionAttempts = 0;
        this.maxRetries = 5;
        this.retryDelay = 5000;
        this.sentinels = [
            {
                host: sentinelHost1 || 'localhost',
                port: parseInt(sentinelPort1) || 26379
            },
            {
                host: sentinelHost2 || 'localhost',
                port: parseInt(sentinelPort2) || 26379
            },
            {
                host: sentinelHost3 || 'localhost',
                port: parseInt(sentinelPort3) || 26379
            }
        ];
    }

    async connect() {
        if (this.isConnected && this.client) {
            return this.client;
        }

        try {
            console.log("Connecting to Redis via Sentinel...");

            this.client = Redis.createClient({
                name: redisMasterName, // sentinel에서 모니터링하는 마스터 이름
                sentinels: this.sentinels,
                sentinelPassword: sentinelPassword, // sentinel 인증이 필요한 경우
                password: redisPassword, // Redis 인증이 필요한 경우
                socket: {
                    reconnectStrategy: (retries) => {
                        if (retries > this.maxRetries) {
                            return null;
                        }
                        return Math.min(retries * 50, 2000);
                    },
                }
            });

            // Sentinel 관련 이벤트 핸들링
            this.client.on("+switch-master", (servername, oldHost, oldPort, newHost, newPort) => {
                console.log(`Master switched from ${oldHost}:${oldPort} to ${newHost}:${newPort}`);
            });

            this.client.on("+sentinel", (channel, sentinel) => {
                console.log(`New sentinel discovered: ${sentinel}`);
            });

            this.client.on("-sentinel", (channel, sentinel) => {
                console.log(`Sentinel disconnected: ${sentinel}`);
            });

            this.client.on("connect", () => {
                console.log("Redis Client Connected via Sentinel");
                this.isConnected = true;
                this.connectionAttempts = 0;
            });

            this.client.on("error", (err) => {
                console.error("Redis Client Error:", err);
                this.isConnected = false;
            });

            await this.client.connect();
            return this.client;
        } catch (error) {
            console.error("Redis connection error:", error);
            this.isConnected = false;
            throw error;
        }
    }

    // 기존 메서드들은 동일하게 유지
    async set(key, value, options = {}) {
        try {
            if (!this.isConnected) {
                await this.connect();
            }

            let stringValue;
            if (typeof value === "object") {
                stringValue = JSON.stringify(value);
            } else {
                stringValue = String(value);
            }

            if (options.ttl) {
                return await this.client.setEx(key, options.ttl, stringValue);
            }
            return await this.client.set(key, stringValue);
        } catch (error) {
            console.error("Redis set error:", error);
            throw error;
        }
    }

    async get(key) {
        try {
            if (!this.isConnected) {
                await this.connect();
            }

            const value = await this.client.get(key);
            if (!value) return null;

            try {
                return JSON.parse(value);
            } catch (parseError) {
                return value;
            }
        } catch (error) {
            console.error("Redis get error:", error);
            throw error;
        }
    }

    async setEx(key, seconds, value) {
        try {
            if (!this.isConnected) {
                await this.connect();
            }

            let stringValue;
            if (typeof value === "object") {
                stringValue = JSON.stringify(value);
            } else {
                stringValue = String(value);
            }

            return await this.client.setEx(key, seconds, stringValue);
        } catch (error) {
            console.error("Redis setEx error:", error);
            throw error;
        }
    }

    async del(key) {
        try {
            if (!this.isConnected) {
                await this.connect();
            }
            return await this.client.del(key);
        } catch (error) {
            console.error("Redis del error:", error);
            throw error;
        }
    }

    async expire(key, seconds) {
        try {
            if (!this.isConnected) {
                await this.connect();
            }
            return await this.client.expire(key, seconds);
        } catch (error) {
            console.error("Redis expire error:", error);
            throw error;
        }
    }

    async quit() {
        if (this.client) {
            try {
                await this.client.quit();
                this.isConnected = false;
                this.client = null;
                console.log("Redis connection closed successfully");
            } catch (error) {
                console.error("Redis quit error:", error);
                throw error;
            }
        }
    }
}

const redisClient = new RedisClient();
module.exports = redisClient;