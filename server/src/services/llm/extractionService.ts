import { db } from '../../db/database';
import { writeAudit } from '../auditLog';
import { broadcast, broadcastToUser } from '../../websocket';
import { resolveUserConfig, createProvider } from './providerFactory';
import { prepareFileContent } from './fileProcessor';
import { EXTRACTION_SYSTEM_PROMPT, REPAIR_PROMPT } from './prompt';
import type { ExtractedReservation } from './types';

interface NominatimResult {
  lat: string;
  lon: string;
  display_name: string;
}

// Simple in-process geocode cache to avoid duplicate requests within a single extraction job
const geocodeCache = new Map<string, { lat: number; lng: number } | null>();

async function geocodeLocation(query: string): Promise<{ lat: number; lng: number } | null> {
  const key = query.toLowerCase().trim();
  if (geocodeCache.has(key)) return geocodeCache.get(key)!;

  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'TREK-travel-planner/1.0 (self-hosted)' },
    });
    if (!res.ok) {
      geocodeCache.set(key, null);
      return null;
    }
    const data = (await res.json()) as NominatimResult[];
    if (!data.length) {
      geocodeCache.set(key, null);
      return null;
    }
    const result = { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
    geocodeCache.set(key, result);
    return result;
  } catch {
    geocodeCache.set(key, null);
    return null;
  }
}

interface TripFile {
  id: number;
  filename: string;
  mime_type: string | null;
  original_name: string;
}

interface Day {
  id: number;
  day_number: number;
  date: string | null;
}

/**
 * Main extraction orchestration function.
 * Called by both the DB queue and Redis queue workers.
 */
export async function extractReservations(
  jobId: number,
  tripId: number,
  fileId: number,
  userId: number
): Promise<void> {
  try {
    // Load the file record
    const file = db.prepare('SELECT id, filename, mime_type, original_name FROM trip_files WHERE id = ? AND trip_id = ?')
      .get(fileId, tripId) as TripFile | undefined;

    if (!file) {
      failJob(jobId, userId, tripId, 'File not found or does not belong to this trip');
      return;
    }

    // Resolve LLM config for this user
    const config = resolveUserConfig(userId);
    if (!config) {
      failJob(jobId, userId, tripId, 'No LLM provider configured. Please set up AI extraction in your settings or ask your admin.');
      return;
    }

    const provider = createProvider(config);
    const mimeType = file.mime_type ?? 'application/octet-stream';

    // Prepare file content (vision or text extraction)
    let contentParts;
    try {
      contentParts = await prepareFileContent(file.filename, mimeType, provider);
    } catch (err) {
      failJob(jobId, userId, tripId, `File processing failed: ${(err as Error).message}`);
      return;
    }

    // Build LLM messages
    const messages = [
      { role: 'system' as const, content: EXTRACTION_SYSTEM_PROMPT },
      { role: 'user' as const, content: contentParts },
    ];

    // Call LLM
    let rawResponse: string;
    try {
      rawResponse = await provider.chat(messages, { temperature: 0.1, maxTokens: 4096 });
    } catch (err) {
      await handleProviderError(jobId, userId, tripId, err as Error);
      return;
    }

    // Parse response — with one repair attempt on invalid JSON
    let extracted: ExtractedReservation[];
    try {
      extracted = parseExtractionResponse(rawResponse);
    } catch {
      try {
        const repairResponse = await provider.chat([
          ...messages,
          { role: 'user' as const, content: rawResponse },
          { role: 'user' as const, content: REPAIR_PROMPT },
        ]);
        extracted = parseExtractionResponse(repairResponse);
      } catch {
        failJob(jobId, userId, tripId, 'LLM returned invalid JSON and repair failed.');
        return;
      }
    }

    if (!Array.isArray(extracted) || extracted.length === 0) {
      db.prepare(`
        UPDATE extraction_jobs
        SET status = 'completed', reservations_created = 0, completed_at = CURRENT_TIMESTAMP,
            result = '[]'
        WHERE id = ?
      `).run(jobId);
      broadcastToUser(userId, { type: 'extraction:complete', tripId, jobId, count: 0 });
      return;
    }

    // Load trip days for date-matching
    const days = db.prepare('SELECT id, day_number, date FROM days WHERE trip_id = ? ORDER BY day_number ASC')
      .all(tripId) as Day[];

    // Clear per-job geocode cache
    geocodeCache.clear();

    // Create reservations
    const createdReservations: object[] = [];
    for (const item of extracted) {
      const reservation = await createReservationFromExtracted(item, tripId, days);
      createdReservations.push(reservation);
    }

    // Update job as completed
    db.prepare(`
      UPDATE extraction_jobs
      SET status = 'completed', reservations_created = ?, completed_at = CURRENT_TIMESTAMP,
          result = ?, provider = ?, model = ?
      WHERE id = ?
    `).run(createdReservations.length, JSON.stringify(createdReservations), config.provider, config.model, jobId);

    writeAudit({
      userId,
      action: 'extraction.complete',
      resource: `trip:${tripId}`,
      details: { jobId, count: createdReservations.length, provider: config.provider },
    });

    broadcastToUser(userId, { type: 'extraction:complete', tripId, jobId, count: createdReservations.length });
    broadcast(tripId, 'reservation:bulk_created', { reservations: createdReservations });
  } catch (err) {
    console.error(`[Extraction] Unexpected error for job ${jobId}:`, err);
    failJob(jobId, userId, tripId, `Unexpected error: ${(err as Error).message}`);
  }
}

async function createReservationFromExtracted(
  item: ExtractedReservation,
  tripId: number,
  days: Day[]
): Promise<object> {
  // Try to find or create a place for the location
  let placeId: number | null = null;

  const meta = item.metadata as Record<string, string> | null | undefined;
  const iataFrom = item.type === 'flight' && meta?.departure_airport
    ? String(meta.departure_airport).toUpperCase().trim()
    : null;

  if (item.location || iataFrom) {
    // For flights, prefer the IATA code as the canonical place name (e.g. "JFK"),
    // and build a geocoding query that reliably resolves to the airport.
    let placeName: string;
    let geocodeQuery: string;

    if (iataFrom) {
      // Derive a human-readable name from the location string if available,
      // then suffix it with the IATA code so it's unambiguous.
      const locationLabel = item.location
        ? item.location.split(',')[0].trim()
        : iataFrom;
      placeName = `${locationLabel} (${iataFrom})`;
      geocodeQuery = item.location ?? `${iataFrom} airport`;
    } else {
      // Non-flight: use first segment of location as display name.
      placeName = item.location!.split(',')[0].trim() || item.location!;
      geocodeQuery = item.location!;
    }

    // Deduplication: for flights match by IATA suffix; for others match by name/address.
    const existing = iataFrom
      ? db.prepare(
          "SELECT id FROM places WHERE trip_id = ? AND name LIKE ? LIMIT 1"
        ).get(tripId, `%(${iataFrom})`) as { id: number } | undefined
      : db.prepare(
          'SELECT id FROM places WHERE trip_id = ? AND (name = ? OR address = ?) LIMIT 1'
        ).get(tripId, placeName, geocodeQuery) as { id: number } | undefined;

    if (existing) {
      placeId = existing.id;
    } else {
      const coords = await geocodeLocation(geocodeQuery);

      const placeResult = db.prepare(
        'INSERT INTO places (trip_id, name, address, lat, lng, transport_mode) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(tripId, placeName, geocodeQuery, coords?.lat ?? null, coords?.lng ?? null, 'walking');
      placeId = placeResult.lastInsertRowid as number;
    }
  }

  // Match to a day by comparing reservation_time date to day dates
  let dayId: number | null = null;
  if (item.reservation_time && days.length > 0) {
    const reservationDate = item.reservation_time.substring(0, 10); // YYYY-MM-DD
    const matchedDay = days.find((d) => d.date && d.date.substring(0, 10) === reservationDate);
    if (matchedDay) dayId = matchedDay.id;
  }

  // Check for duplicate by confirmation number
  if (item.confirmation_number) {
    const existing = db.prepare(
      'SELECT id FROM reservations WHERE trip_id = ? AND confirmation_number = ? LIMIT 1'
    ).get(tripId, item.confirmation_number) as { id: number } | undefined;
    if (existing) {
      // Return the existing reservation without creating a duplicate
      return db.prepare('SELECT * FROM reservations WHERE id = ?').get(existing.id) as object;
    }
  }

  const result = db.prepare(`
    INSERT INTO reservations (
      trip_id, day_id, place_id, title, type, reservation_time, reservation_end_time,
      location, confirmation_number, notes, status, metadata, needs_review
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, 1)
  `).run(
    tripId,
    dayId,
    placeId,
    item.title,
    item.type ?? 'other',
    item.reservation_time ?? null,
    item.reservation_end_time ?? null,
    item.location ?? null,
    item.confirmation_number ?? null,
    item.notes ?? null,
    item.metadata ? JSON.stringify(item.metadata) : null
  );

  return db.prepare('SELECT * FROM reservations WHERE id = ?').get(result.lastInsertRowid) as object;
}

function parseExtractionResponse(raw: string): ExtractedReservation[] {
  // Strip possible markdown code fences
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();

  const parsed = JSON.parse(cleaned);
  if (!Array.isArray(parsed)) throw new Error('Response is not a JSON array');
  return parsed as ExtractedReservation[];
}

async function handleProviderError(jobId: number, userId: number, tripId: number, err: Error): Promise<void> {
  const job = db.prepare('SELECT retry_count, max_retries FROM extraction_jobs WHERE id = ?')
    .get(jobId) as { retry_count: number; max_retries: number } | undefined;

  if (job && job.retry_count < job.max_retries) {
    // Re-queue for retry
    db.prepare(`
      UPDATE extraction_jobs SET status = 'pending', retry_count = retry_count + 1 WHERE id = ?
    `).run(jobId);
  } else {
    failJob(jobId, userId, tripId, err.message);
  }
}

function failJob(jobId: number, userId: number, tripId: number, error: string): void {
  db.prepare(`
    UPDATE extraction_jobs
    SET status = 'failed', error = ?, completed_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(error, jobId);

  writeAudit({
    userId,
    action: 'extraction.failed',
    resource: `trip:${tripId}`,
    details: { jobId, error },
  });

  broadcastToUser(userId, { type: 'extraction:failed', tripId, jobId, error });
}
