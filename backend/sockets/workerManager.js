// workerManager.js
const { Worker } = require("worker_threads");
const path = require("path");

class WorkerManager {
  constructor(workerCount) {
    this.workers = [];
    this.currentWorkerIndex = 0;
    this.messageCallbacks = new Map();

    for (let i = 0; i < workerCount; i++) {
      const worker = new Worker(path.join(__dirname, "chatWorker.js"), {
        workerData: { workerId: i },
      });

      worker.on("message", (response) => {
        const callback = this.messageCallbacks.get(response.id);
        if (callback) {
          if (response.error) {
            callback.reject(new Error(response.error));
          } else {
            callback.resolve(response.result);
          }
          this.messageCallbacks.delete(response.id);
        }
      });

      worker.on("error", (error) => {
        console.error(`Worker ${i} error:`, error);
        // 에러가 발생한 워커의 콜백들을 reject
        for (const [messageId, callback] of this.messageCallbacks) {
          if (callback.workerId === i) {
            callback.reject(error);
            this.messageCallbacks.delete(messageId);
          }
        }
      });

      this.workers.push(worker);
    }
  }

  getNextWorker() {
    const worker = this.workers[this.currentWorkerIndex];
    this.currentWorkerIndex =
      (this.currentWorkerIndex + 1) % this.workers.length;
    return worker;
  }

  executeTask(type, payload) {
    return new Promise((resolve, reject) => {
      const messageId = `${Date.now()}-${Math.random()}`;
      const worker = this.getNextWorker();
      const workerIndex = this.workers.indexOf(worker);

      // 직렬화 가능한 데이터만 전송
      const serializedPayload = JSON.parse(JSON.stringify(payload));

      this.messageCallbacks.set(messageId, {
        resolve,
        reject,
        workerId: workerIndex,
      });

      worker.postMessage({
        id: messageId,
        data: { type, payload: serializedPayload },
      });
    });
  }

  async terminate() {
    const terminationPromises = this.workers.map(async (worker) => {
      try {
        await worker.terminate();
      } catch (error) {
        console.error("Worker termination error:", error);
      }
    });
    await Promise.all(terminationPromises);
  }
}

module.exports = WorkerManager;
