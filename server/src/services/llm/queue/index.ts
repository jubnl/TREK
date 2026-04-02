import type { ExtractionQueue } from './types';
import { DbExtractionQueue } from './dbQueue';

let _queue: ExtractionQueue | null = null;

export function getExtractionQueue(): ExtractionQueue {
  if (_queue) return _queue;

  if (process.env.QUEUE_TYPE === 'redis' && process.env.QUEUE_URL) {
    const { RedisExtractionQueue } = require('./redisQueue') as typeof import('./redisQueue');
    _queue = new RedisExtractionQueue(process.env.QUEUE_URL);
    console.log('[Queue] Using Redis/BullMQ extraction queue');
  } else {
    _queue = new DbExtractionQueue();
    console.log('[Queue] Using DB-backed extraction queue');
  }

  return _queue;
}
