export interface QueueJob {
  id: number;       // extraction_jobs.id
  tripId: number;
  fileId: number;
  userId: number;
}

export interface ExtractionQueue {
  enqueue(job: QueueJob): Promise<void>;
  start(): void;
  stop(): void;
}
