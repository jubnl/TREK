import { db } from '../../../db/database';
import type { ExtractionQueue, QueueJob } from './types';
import { extractReservations } from '../extractionService';

export class DbExtractionQueue implements ExtractionQueue {
  private interval: ReturnType<typeof setInterval> | null = null;
  private processing = false;

  async enqueue(_job: QueueJob): Promise<void> {
    // The job row already exists in extraction_jobs when this is called.
    // Nothing to do — the polling loop will pick it up by status = 'pending'.
  }

  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => {
      void this.processNext();
    }, 5000);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private async processNext(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      // Atomically claim the oldest pending job
      const job = db.prepare(`
        UPDATE extraction_jobs
        SET status = 'processing', started_at = CURRENT_TIMESTAMP
        WHERE id = (
          SELECT id FROM extraction_jobs
          WHERE status = 'pending'
          ORDER BY created_at ASC
          LIMIT 1
        )
        RETURNING id, trip_id, file_id, user_id, max_retries
      `).get() as { id: number; trip_id: number; file_id: number; user_id: number; max_retries: number } | undefined;

      if (!job) return;

      await extractReservations(job.id, job.trip_id, job.file_id, job.user_id);
    } catch (err) {
      console.error('[DbQueue] Unhandled error in processNext:', err);
    } finally {
      this.processing = false;
    }
  }
}
