import { getDb } from '../db/index.js';
import { getProvider } from '../providers/index.js';
import { decrypt } from '../lib/crypto.js';
import { canMakeRequest, canUseTokens, isOnCooldown } from './ratelimit.js';
import type { BaseProvider } from '../providers/base.js';

interface ModelRow {
  id: number;
  platform: string;
  model_id: string;
  display_name: string;
  intelligence_rank: number;
  rpm_limit: number | null;
  rpd_limit: number | null;
  tpm_limit: number | null;
  tpd_limit: number | null;
  context_window: number | null;
}

interface KeyRow {
  id: number;
  platform: string;
  encrypted_key: string;
  iv: string;
  auth_tag: string;
  status: string;
  enabled: number;
}

interface FallbackRow {
  model_db_id: number;
  priority: number;
  enabled: number;
}

interface ChainEntry extends FallbackRow {
  effectivePriority: number;
}

export interface RouteResult {
  provider: BaseProvider;
  modelId: string;
  modelDbId: number;
  apiKey: string;
  keyId: number;
  platform: string;
  displayName: string;
}

export type PreferredModelSource = 'sticky' | 'explicit';

interface RouteRequestOptions {
  estimatedTokens?: number;
  skipKeys?: Set<string>;
  skipRoutes?: Set<string>;
  preferredModelDbId?: number;
  preferredModelSource?: PreferredModelSource;
  allowedModelIds?: Set<number>;
}

const QUALITY_FALLBACK_BAND = 2;

// Round-robin index per platform
const roundRobinIndex = new Map<string, number>();

// ── Dynamic priority: track 429s per model and demote accordingly ──
// Key: model_db_id → { count, lastHit, penalty }
const rateLimitPenalties = new Map<number, { count: number; lastHit: number; penalty: number }>();

// Penalty decays over time so models recover
const PENALTY_PER_429 = 3;        // each 429 adds this many priority positions
const MAX_PENALTY = 10;            // cap so a model doesn't sink forever
const DECAY_INTERVAL_MS = 2 * 60 * 1000; // penalty decays every 2 minutes
const DECAY_AMOUNT = 1;            // remove this much penalty per decay interval

/**
 * Record a 429 for a model — increases its penalty so it sinks in priority.
 */
export function recordRateLimitHit(modelDbId: number) {
  const existing = rateLimitPenalties.get(modelDbId);
  const now = Date.now();
  if (existing) {
    existing.count++;
    existing.lastHit = now;
    existing.penalty = Math.min(existing.penalty + PENALTY_PER_429, MAX_PENALTY);
  } else {
    rateLimitPenalties.set(modelDbId, { count: 1, lastHit: now, penalty: PENALTY_PER_429 });
  }
}

/**
 * Record a success for a model — reduces its penalty so it rises back up.
 */
export function recordSuccess(modelDbId: number) {
  const existing = rateLimitPenalties.get(modelDbId);
  if (existing) {
    existing.penalty = Math.max(0, existing.penalty - 1);
    if (existing.penalty === 0) {
      rateLimitPenalties.delete(modelDbId);
    }
  }
}

/**
 * Get the current penalty for a model (with time-based decay).
 */
function getPenalty(modelDbId: number): number {
  const entry = rateLimitPenalties.get(modelDbId);
  if (!entry) return 0;

  // Apply time-based decay
  const now = Date.now();
  const elapsed = now - entry.lastHit;
  const decaySteps = Math.floor(elapsed / DECAY_INTERVAL_MS);
  if (decaySteps > 0) {
    entry.penalty = Math.max(0, entry.penalty - (decaySteps * DECAY_AMOUNT));
    entry.lastHit = now; // reset so we don't double-decay
    if (entry.penalty === 0) {
      rateLimitPenalties.delete(modelDbId);
      return 0;
    }
  }

  return entry.penalty;
}

/**
 * Get current penalties for all models (for the API/dashboard).
 */
export function getAllPenalties(): Array<{ modelDbId: number; count: number; penalty: number }> {
  const result: Array<{ modelDbId: number; count: number; penalty: number }> = [];
  for (const [modelDbId, entry] of rateLimitPenalties) {
    const penalty = getPenalty(modelDbId);
    if (penalty > 0) {
      result.push({ modelDbId, count: entry.count, penalty });
    }
  }
  return result.sort((a, b) => b.penalty - a.penalty);
}

function modelCanFit(model: ModelRow, estimatedTokens: number): boolean {
  return model.context_window === null || estimatedTokens <= model.context_window;
}

function createRoutingError(status: number, message: string) {
  const err = new Error(message) as Error & { status?: number };
  err.status = status;
  return err;
}

function getModel(db: ReturnType<typeof getDb>, modelDbId: number): ModelRow | undefined {
  return db.prepare('SELECT * FROM models WHERE id = ? AND enabled = 1').get(modelDbId) as ModelRow | undefined;
}

function sortByEffectivePriority(a: ChainEntry, b: ChainEntry): number {
  if (a.effectivePriority !== b.effectivePriority) {
    return a.effectivePriority - b.effectivePriority;
  }
  return a.priority - b.priority;
}

/**
 * Route a request to the best available model.
 * Models are sorted by (base_priority + rate_limit_penalty) so frequently
 * rate-limited models automatically sink below working ones.
 *
 * If preferredModelDbId is set, that model gets tried FIRST (sticky sessions).
 * This prevents hallucination from model switching mid-conversation.
 *
 * @param estimatedTokens - estimated total tokens for rate limit check
 * @param skipKeys - set of "platform:modelId:keyId" to skip (failed on this request)
 * @param preferredModelDbId - try this model first (sticky session)
 */
export function routeRequest(
  optionsOrEstimatedTokens: RouteRequestOptions | number = 1000,
  legacySkipKeys?: Set<string>,
  legacyPreferredModelDbId?: number,
): RouteResult {
  const options: RouteRequestOptions =
    typeof optionsOrEstimatedTokens === 'number'
      ? {
          estimatedTokens: optionsOrEstimatedTokens,
          skipKeys: legacySkipKeys,
          preferredModelDbId: legacyPreferredModelDbId,
          preferredModelSource: legacyPreferredModelDbId ? 'sticky' : undefined,
        }
      : optionsOrEstimatedTokens;

  const estimatedTokens = options.estimatedTokens ?? 1000;
  const skipKeys = options.skipKeys;
  const skipRoutes = options.skipRoutes;
  const preferredModelDbId = options.preferredModelDbId;
  const preferredModelSource = options.preferredModelSource;
  const allowedModelIds = options.allowedModelIds;
  const db = getDb();

  // Get fallback chain ordered by priority
  const fallbackChain = db.prepare(`
    SELECT fc.model_db_id, fc.priority, fc.enabled
    FROM fallback_config fc
    ORDER BY fc.priority ASC
  `).all() as FallbackRow[];

  // Apply dynamic penalties: sort by (base priority + penalty)
  const sortedChain = fallbackChain.map(entry => ({
    ...entry,
    effectivePriority: entry.priority + getPenalty(entry.model_db_id),
  })).sort(sortByEffectivePriority);

  const preferredModel = preferredModelDbId ? getModel(db, preferredModelDbId) : undefined;
  const preferredTooSmall =
    !!preferredModel &&
    !modelCanFit(preferredModel, estimatedTokens);

  const shouldUseQualityPreservingContextFallback =
    preferredTooSmall &&
    preferredModelSource === 'sticky' &&
    !allowedModelIds;

  if (shouldUseQualityPreservingContextFallback && preferredModel) {
    const maxRank = preferredModel.intelligence_rank + QUALITY_FALLBACK_BAND;
    const nearby: ChainEntry[] = [];
    const later: ChainEntry[] = [];

    for (const entry of sortedChain) {
      const model = getModel(db, entry.model_db_id);
      if (model && model.intelligence_rank <= maxRank) {
        nearby.push(entry);
      } else {
        later.push(entry);
      }
    }

    sortedChain.splice(
      0,
      sortedChain.length,
      ...nearby.sort(sortByEffectivePriority),
      ...later.sort(sortByEffectivePriority),
    );
  } else if (preferredModelDbId) {
    // Sticky or explicit preference: try preferred first when it is not a
    // known-too-small sticky model. Explicit model pinning is enforced by
    // allowedModelIds supplied by the proxy layer.
    const idx = sortedChain.findIndex(e => e.model_db_id === preferredModelDbId);
    if (idx > 0) {
      const [preferred] = sortedChain.splice(idx, 1);
      sortedChain.unshift(preferred);
    }
  }

  const exhaustion = {
    contextTooLarge: 0,
    rateLimited: 0,
    unavailable: 0,
  };

  for (const entry of sortedChain) {
    if (!entry.enabled) continue;
    if (allowedModelIds && !allowedModelIds.has(entry.model_db_id)) continue;

    // Get model details
    const model = getModel(db, entry.model_db_id);
    if (!model) continue;

    const routeSkipId = `${model.platform}:${model.id}`;
    if (skipRoutes?.has(routeSkipId)) continue;

    if (!modelCanFit(model, estimatedTokens)) {
      exhaustion.contextTooLarge++;
      continue;
    }

    // Check if we have a provider for this platform
    const provider = getProvider(model.platform as any);
    if (!provider) {
      exhaustion.unavailable++;
      continue;
    }

    // Get all enabled keys for this platform except confirmed invalid keys.
    // Keep status='error' routable: it can be temporary provider/transport/quota state.
    const keys = db.prepare(
      'SELECT * FROM api_keys WHERE platform = ? AND enabled = 1 AND status != ?'
    ).all(model.platform, 'invalid') as KeyRow[];

    if (keys.length === 0) {
      exhaustion.unavailable++;
      continue;
    }

    // Get limits once for this model
    const limits = {
      rpm: model.rpm_limit,
      rpd: model.rpd_limit,
      tpm: model.tpm_limit,
      tpd: model.tpd_limit,
    };

    // Try all keys for this model before giving up on it
    const rrKey = `${model.platform}:${model.model_id}`;
    let idx = roundRobinIndex.get(rrKey) ?? 0;

    for (let attempt = 0; attempt < keys.length; attempt++) {
      const key = keys[idx % keys.length];
      idx++;

      const skipId = `${model.platform}:${model.model_id}:${key.id}`;
      if (skipKeys?.has(skipId)) continue;

      // Check cooldown / quota windows.
      if (isOnCooldown(model.platform, model.model_id, key.id)) {
        exhaustion.rateLimited++;
        continue;
      }
      if (!canMakeRequest(model.platform, model.model_id, key.id, limits)) {
        exhaustion.rateLimited++;
        continue;
      }
      if (!canUseTokens(model.platform, model.model_id, key.id, estimatedTokens, limits)) {
        exhaustion.rateLimited++;
        continue;
      }

      let decryptedKey: string;
      try {
        decryptedKey = decrypt(key.encrypted_key, key.iv, key.auth_tag);
      } catch {
        db.prepare("UPDATE api_keys SET status = 'error', last_checked_at = datetime('now') WHERE id = ?")
          .run(key.id);
        exhaustion.unavailable++;
        continue;
      }

      // We found a working key for this model!
      roundRobinIndex.set(rrKey, idx);

      return {
        provider,
        modelId: model.model_id,
        modelDbId: model.id,
        apiKey: decryptedKey,
        keyId: key.id,
        platform: model.platform,
        displayName: model.display_name,
      };
    }

    // If we reach here, this specific model has NO available keys.
    // Update round-robin index even if we failed so we don't get stuck.
    roundRobinIndex.set(rrKey, idx);
    
    // We don't explicitly penalize the model here because the fact that we 
    // couldn't find a key means we will naturally move to the next model 
    // in the `sortedChain` for THIS specific request.
  }

  if (exhaustion.contextTooLarge > 0) {
    throw createRoutingError(
      413,
      `Request requires approximately ${estimatedTokens} tokens, but no enabled model route has a known context window large enough.`,
    );
  }

  if (exhaustion.rateLimited > 0) {
    throw createRoutingError(429, 'All models exhausted by rate limits or token quotas.');
  }

  throw createRoutingError(
    503,
    'All models exhausted. No usable model route is currently available.',
  );
}
