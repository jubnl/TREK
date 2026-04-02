import express, { Request, Response } from 'express';
import { db, canAccessTrip } from '../db/database';
import { authenticate } from '../middleware/auth';
import { broadcast } from '../websocket';
import { AuthRequest, ExtractionJob } from '../types';
import { writeAudit, getClientIp } from '../services/auditLog';
import { maybe_encrypt_api_key, decrypt_api_key } from '../services/apiKeyCrypto';
import { resolveUserConfig, isCloudProvider } from '../services/llm/providerFactory';
import { getExtractionQueue } from '../services/llm/queue';

const router = express.Router();
router.use(authenticate);

function isAddonEnabled(): boolean {
  const row = db.prepare("SELECT enabled FROM addons WHERE id = 'llm-extract'").get() as { enabled: number } | undefined;
  return !!row?.enabled;
}

// POST /api/integrations/llm-extract/extract
router.post('/extract', async (req: Request, res: Response) => {
  if (!isAddonEnabled()) return res.status(403).json({ error: 'AI Extraction addon is not enabled' });

  const authReq = req as AuthRequest;
  const { tripId, fileId, cloud_acknowledged } = req.body;

  if (!tripId || !fileId) return res.status(400).json({ error: 'tripId and fileId are required' });

  const trip = canAccessTrip(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  // Check file belongs to trip
  const file = db.prepare('SELECT id FROM trip_files WHERE id = ? AND trip_id = ? AND deleted_at IS NULL')
    .get(fileId, tripId);
  if (!file) return res.status(404).json({ error: 'File not found' });

  // Resolve config to check provider type
  const config = resolveUserConfig(authReq.user.id);
  if (!config) return res.status(400).json({ error: 'No LLM provider configured. Set up AI extraction in your settings.' });

  // Require acknowledgment for cloud providers
  if (isCloudProvider(config.provider) && !cloud_acknowledged) {
    return res.status(400).json({
      error: 'cloud_acknowledgment_required',
      provider: config.provider,
      message: 'Your data will be sent to an external cloud LLM provider. Please acknowledge the privacy notice.',
    });
  }

  // Get addon config for max_retries
  const addonRow = db.prepare("SELECT config FROM addons WHERE id = 'llm-extract'").get() as { config: string } | undefined;
  const addonConfig = addonRow ? (JSON.parse(addonRow.config) as { max_retries?: number }) : {};
  const maxRetries = addonConfig.max_retries ?? 3;

  // Create the job
  const result = db.prepare(`
    INSERT INTO extraction_jobs (trip_id, file_id, user_id, status, provider, model, max_retries)
    VALUES (?, ?, ?, 'pending', ?, ?, ?)
  `).run(tripId, fileId, authReq.user.id, config.provider, config.model, maxRetries);

  const jobId = result.lastInsertRowid as number;

  writeAudit({
    userId: authReq.user.id,
    action: 'extraction.start',
    resource: `trip:${tripId}`,
    details: { jobId, fileId, provider: config.provider },
    ip: getClientIp(req),
  });

  // Enqueue
  await getExtractionQueue().enqueue({ id: jobId, tripId: Number(tripId), fileId: Number(fileId), userId: authReq.user.id });

  const job = db.prepare('SELECT * FROM extraction_jobs WHERE id = ?').get(jobId) as ExtractionJob;
  res.json({ job });
});

// GET /api/integrations/llm-extract/jobs/:tripId
router.get('/jobs/:tripId', (req: Request, res: Response) => {
  if (!isAddonEnabled()) return res.status(403).json({ error: 'AI Extraction addon is not enabled' });

  const authReq = req as AuthRequest;
  const { tripId } = req.params;

  const trip = canAccessTrip(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  const jobs = db.prepare(
    'SELECT * FROM extraction_jobs WHERE trip_id = ? ORDER BY created_at DESC'
  ).all(tripId) as ExtractionJob[];

  res.json({ jobs });
});

// GET /api/integrations/llm-extract/job/:jobId
router.get('/job/:jobId', (req: Request, res: Response) => {
  if (!isAddonEnabled()) return res.status(403).json({ error: 'AI Extraction addon is not enabled' });

  const authReq = req as AuthRequest;
  const { jobId } = req.params;

  const job = db.prepare('SELECT * FROM extraction_jobs WHERE id = ?').get(jobId) as ExtractionJob | undefined;
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const trip = canAccessTrip(job.trip_id, authReq.user.id);
  if (!trip) return res.status(403).json({ error: 'Access denied' });

  res.json({ job });
});

// POST /api/integrations/llm-extract/review
router.post('/review', (req: Request, res: Response) => {
  if (!isAddonEnabled()) return res.status(403).json({ error: 'AI Extraction addon is not enabled' });

  const authReq = req as AuthRequest;
  const { reservationIds, action, tripId } = req.body;

  if (!Array.isArray(reservationIds) || reservationIds.length === 0) {
    return res.status(400).json({ error: 'reservationIds must be a non-empty array' });
  }
  if (action !== 'confirm' && action !== 'reject') {
    return res.status(400).json({ error: 'action must be "confirm" or "reject"' });
  }

  // Verify all reservations belong to a trip the user can access
  if (tripId) {
    const trip = canAccessTrip(tripId, authReq.user.id);
    if (!trip) return res.status(403).json({ error: 'Access denied' });
  }

  const placeholders = reservationIds.map(() => '?').join(',');

  if (action === 'confirm') {
    db.prepare(`UPDATE reservations SET needs_review = 0, status = 'confirmed' WHERE id IN (${placeholders})`).run(...reservationIds);
    if (tripId) broadcast(Number(tripId), 'reservation:bulk_reviewed', { reservationIds, action: 'confirm' });
    res.json({ success: true, confirmed: reservationIds.length });
  } else {
    db.prepare(`DELETE FROM reservations WHERE id IN (${placeholders})`).run(...reservationIds);
    if (tripId) broadcast(Number(tripId), 'reservation:bulk_deleted', { reservationIds });
    res.json({ success: true, rejected: reservationIds.length });
  }
});

// GET /api/integrations/llm-extract/config
router.get('/config', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const config = resolveUserConfig(authReq.user.id);

  if (!config) {
    return res.json({ configured: false });
  }

  res.json({
    configured: true,
    provider: config.provider,
    model: config.model,
    hasApiKey: !!config.apiKey,
    isCloud: isCloudProvider(config.provider),
    baseUrl: config.baseUrl ?? null,
  });
});

// PUT /api/integrations/llm-extract/config
router.put('/config', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { provider, apiKey, model, baseUrl } = req.body;

  const set = (key: string, value: string | null) => {
    if (value === null || value === undefined) {
      db.prepare('DELETE FROM settings WHERE user_id = ? AND key = ?').run(authReq.user.id, key);
    } else {
      db.prepare('INSERT OR REPLACE INTO settings (user_id, key, value) VALUES (?, ?, ?)').run(authReq.user.id, key, value);
    }
  };

  if (provider !== undefined) set('llm_provider', provider || null);
  if (model !== undefined) set('llm_model', model || null);
  if (baseUrl !== undefined) set('llm_base_url', baseUrl || null);
  if (apiKey !== undefined) {
    const encrypted = apiKey ? maybe_encrypt_api_key(apiKey) : null;
    set('llm_api_key', encrypted);

    // Audit cloud key additions
    if (apiKey && provider && isCloudProvider(provider)) {
      writeAudit({
        userId: authReq.user.id,
        action: 'extraction.cloud_key_added',
        details: { provider },
        ip: getClientIp(req),
      });
    }
  }

  writeAudit({
    userId: authReq.user.id,
    action: 'extraction.user_config_update',
    details: { provider, hasKey: !!apiKey },
    ip: getClientIp(req),
  });

  res.json({ success: true });
});

// POST /api/integrations/llm-extract/models
// Fetch available models for a given provider. Body: { provider, apiKey?, baseUrl? }
// If apiKey is not provided, falls back to user/admin stored key.
router.post('/models', async (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { provider, apiKey, baseUrl } = req.body;

  if (!provider) return res.status(400).json({ error: 'provider is required' });

  try {
    const models = await fetchModels(
      provider,
      apiKey || resolveStoredApiKey(authReq.user.id, provider),
      baseUrl
    );
    res.json({ models });
  } catch (err) {
    res.status(502).json({ error: `Failed to fetch models: ${(err as Error).message}` });
  }
});

export default router;

// --- model fetching helpers ---

import { decrypt_api_key as decryptKey } from '../services/apiKeyCrypto';

function resolveStoredApiKey(userId: number, provider: string): string | undefined {
  // Try user key first, then admin key
  const userRow = db.prepare('SELECT value FROM settings WHERE user_id = ? AND key = ?').get(userId, 'llm_api_key') as { value: string } | undefined;
  const adminRow = db.prepare("SELECT value FROM app_settings WHERE key = 'llm_api_key'").get() as { value: string } | undefined;

  // Only use stored key if the stored provider matches the requested provider
  const userProvider = (db.prepare('SELECT value FROM settings WHERE user_id = ? AND key = ?').get(userId, 'llm_provider') as { value: string } | undefined)?.value;
  const adminProvider = (db.prepare("SELECT value FROM app_settings WHERE key = 'llm_provider'").get() as { value: string } | undefined)?.value;

  if (userRow?.value && userProvider === provider) {
    return decryptKey(userRow.value) ?? undefined;
  }
  if (adminRow?.value && adminProvider === provider) {
    return decryptKey(adminRow.value) ?? undefined;
  }
  return undefined;
}

const ANTHROPIC_MODELS = [
  // Current models
  { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
  { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' },
  // Legacy models
  { id: 'claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5' },
  { id: 'claude-opus-4-5-20251101', name: 'Claude Opus 4.5' },
  { id: 'claude-opus-4-1-20250805', name: 'Claude Opus 4.1' },
  { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4' },
  { id: 'claude-opus-4-20250514', name: 'Claude Opus 4' },
  { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet' },
  { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku' },
  { id: 'claude-3-opus-20240229', name: 'Claude 3 Opus' },
];

async function fetchModels(
  provider: string,
  apiKey: string | undefined,
  baseUrl?: string
): Promise<Array<{ id: string; name: string }>> {
  switch (provider) {
    case 'openai': {
      if (!apiKey) throw new Error('API key required to list OpenAI models');
      const OpenAI = (await import('openai')).default;
      const client = new OpenAI({ apiKey });
      const list = await client.models.list();
      const models: Array<{ id: string; name: string }> = [];
      for await (const m of list) {
        // Filter to chat models only (GPT-*)
        if (m.id.startsWith('gpt-') || m.id.startsWith('o') || m.id.includes('chatgpt')) {
          models.push({ id: m.id, name: m.id });
        }
      }
      models.sort((a, b) => a.id.localeCompare(b.id));
      return models;
    }
    case 'anthropic':
      // Anthropic has no model listing API — return curated list
      return ANTHROPIC_MODELS;
    case 'ollama': {
      const url = (baseUrl || 'http://localhost:11434').replace(/\/$/, '');
      const resp = await fetch(`${url}/api/tags`);
      if (!resp.ok) throw new Error(`Ollama returned ${resp.status}`);
      const data = (await resp.json()) as { models?: Array<{ name: string; model: string }> };
      return (data.models || []).map(m => ({ id: m.name, name: m.name }));
    }
    default:
      return [];
  }
}
