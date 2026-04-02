import type { ExtractionQueue, QueueJob } from './types';
import { extractReservations } from '../extractionService';

const QUEUE_NAME = 'trek-extraction';

export class RedisExtractionQueue implements ExtractionQueue {
  private redisUrl: string;
  private worker: unknown = null;
  private queue: unknown = null;

  constructor(redisUrl: string) {
    this.redisUrl = redisUrl;
  }

  async enqueue(job: QueueJob): Promise<void> {
    const { Queue } = await import('bullmq');
    if (!this.queue) {
      this.queue = new Queue(QUEUE_NAME, { connection: { url: this.redisUrl } });
    }
    await (this.queue as InstanceType<typeof Queue>).add('extract', job, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: 100,
      removeOnFail: 50,
    });
  }

  start(): void {
    void this.startWorker();
  }

  private async startWorker(): Promise<void> {
    const { Worker } = await import('bullmq');
    this.worker = new Worker(
      QUEUE_NAME,
      async (bullJob) => {
        const { id, tripId, fileId, userId } = bullJob.data as QueueJob;
        await extractReservations(id, tripId, fileId, userId);
      },
      {
        connection: { url: this.redisUrl },
        concurrency: 2,
      }
    );
    console.log('[RedisQueue] BullMQ worker started');
  }

  stop(): void {
    if (this.worker) {
      void (this.worker as { close(): Promise<void> }).close();
    }
    if (this.queue) {
      void (this.queue as { close(): Promise<void> }).close();
    }
  }
}
