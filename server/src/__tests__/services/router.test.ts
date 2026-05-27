import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { routeRequest } from '../../services/router.js';

function addHealthyKey(db: ReturnType<typeof getDb>, platform: string) {
  const { encrypted, iv, authTag } = encrypt(`${platform}-test-key`);
  db.prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(platform, `test-${platform}`, encrypted, iv, authTag, 'healthy', 1);
}

function addTestModel(
  db: ReturnType<typeof getDb>,
  options: {
    platform: string;
    modelId: string;
    rank: number;
    priority: number;
    contextWindow: number | null;
  },
) {
  const info = db.prepare(`
    INSERT INTO models (
      platform,
      model_id,
      display_name,
      intelligence_rank,
      speed_rank,
      size_label,
      rpm_limit,
      rpd_limit,
      tpm_limit,
      tpd_limit,
      monthly_token_budget,
      context_window,
      enabled
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    options.platform,
    options.modelId,
    options.modelId,
    options.rank,
    1,
    'Test',
    null,
    null,
    null,
    null,
    '~test',
    options.contextWindow,
    1,
  );
  const id = Number(info.lastInsertRowid);
  db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)')
    .run(id, options.priority);
  return { ...options, id };
}

describe('Router', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare("DELETE FROM fallback_config WHERE model_db_id IN (SELECT id FROM models WHERE model_id LIKE 'test-context-%')").run();
    db.prepare("DELETE FROM models WHERE model_id LIKE 'test-context-%'").run();
    db.prepare('DELETE FROM api_keys').run();
    db.prepare('UPDATE fallback_config SET enabled = 1').run();
    // Reset fallback order to intelligence ranking
    const models = db.prepare('SELECT id, intelligence_rank FROM models ORDER BY intelligence_rank ASC').all() as any[];
    const update = db.prepare('UPDATE fallback_config SET priority = ? WHERE model_db_id = ?');
    for (let i = 0; i < models.length; i++) {
      update.run(i + 1, models[i].id);
    }
  });

  it('should throw when no keys are configured', () => {
    expect(() => routeRequest()).toThrow(/exhausted/i);
  });

  it('should route to highest priority model with available key', () => {
    const db = getDb();
    const { encrypted, iv, authTag } = encrypt('test-groq-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('groq', 'test', encrypted, iv, authTag, 'healthy', 1);

    const result = routeRequest();
    expect(result.platform).toBe('groq');
    expect(result.apiKey).toBe('test-groq-key');
  });

  it('should prefer higher-priority model when keys exist for multiple platforms', () => {
    const db = getDb();

    const googleKey = encrypt('test-google-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('google', 'test', googleKey.encrypted, googleKey.iv, googleKey.authTag, 'healthy', 1);

    const groqKey = encrypt('test-groq-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('groq', 'test', groqKey.encrypted, groqKey.iv, groqKey.authTag, 'healthy', 1);

    // Post-V6: Google's gemini-3.1-pro-preview (rank 1, free-tier-eligible per
    // probe on 2026-04-25) outranks Groq's best free-tier model openai/gpt-oss-120b
    // (rank 6). With keys for both platforms, Google wins.
    const result = routeRequest();
    expect(result.platform).toBe('google');
  });

  it('should skip disabled keys', () => {
    const db = getDb();

    const googleKey = encrypt('test-google-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('google', 'disabled', googleKey.encrypted, googleKey.iv, googleKey.authTag, 'healthy', 0);

    const groqKey = encrypt('test-groq-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('groq', 'test', groqKey.encrypted, groqKey.iv, groqKey.authTag, 'healthy', 1);

    const result = routeRequest();
    expect(result.platform).toBe('groq');
  });

  it('should skip invalid keys', () => {
    const db = getDb();

    const invalidKey = encrypt('invalid-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('google', 'invalid', invalidKey.encrypted, invalidKey.iv, invalidKey.authTag, 'invalid', 1);

    const groqKey = encrypt('test-groq-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('groq', 'test', groqKey.encrypted, groqKey.iv, groqKey.authTag, 'healthy', 1);

    const result = routeRequest();
    expect(result.platform).toBe('groq');
  });

  it('should skip keys that cannot be decrypted and use a valid fallback key', () => {
    const db = getDb();

    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('google', 'corrupt', 'not-hex', 'not-hex', 'not-hex', 'healthy', 1);

    const groqKey = encrypt('test-groq-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('groq', 'test', groqKey.encrypted, groqKey.iv, groqKey.authTag, 'healthy', 1);

    const result = routeRequest();
    const corruptKey = db.prepare("SELECT status, enabled, last_checked_at FROM api_keys WHERE label = 'corrupt'")
      .get() as { status: string; enabled: number; last_checked_at: string | null };

    expect(result.platform).toBe('groq');
    expect(result.apiKey).toBe('test-groq-key');
    expect(corruptKey.status).toBe('error');
    expect(corruptKey.enabled).toBe(1);
    expect(corruptKey.last_checked_at).not.toBeNull();
  });

  it('should keep routable keys with error status if they can be decrypted', () => {
    const db = getDb();

    const groqKey = encrypt('test-groq-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('groq', 'temporary-error', groqKey.encrypted, groqKey.iv, groqKey.authTag, 'error', 1);

    const result = routeRequest();

    expect(result.platform).toBe('groq');
    expect(result.apiKey).toBe('test-groq-key');
  });

  it('should skip a model whose known context window cannot fit the request', () => {
    const db = getDb();
    db.prepare('UPDATE fallback_config SET enabled = 0').run();

    const small = addTestModel(db, {
      platform: 'google',
      modelId: 'test-context-small',
      rank: 1,
      priority: 1,
      contextWindow: 1000,
    });
    const large = addTestModel(db, {
      platform: 'groq',
      modelId: 'test-context-large',
      rank: 2,
      priority: 2,
      contextWindow: 8000,
    });
    addHealthyKey(db, 'google');
    addHealthyKey(db, 'groq');

    const result = routeRequest({ estimatedTokens: 2000 });

    expect(result.modelDbId).toBe(large.id);
    expect(result.modelDbId).not.toBe(small.id);
  });

  it('should keep models with unknown context windows eligible', () => {
    const db = getDb();
    db.prepare('UPDATE fallback_config SET enabled = 0').run();

    const unknown = addTestModel(db, {
      platform: 'google',
      modelId: 'test-context-unknown',
      rank: 1,
      priority: 1,
      contextWindow: null,
    });
    addHealthyKey(db, 'google');

    const result = routeRequest({ estimatedTokens: 200_000 });

    expect(result.modelDbId).toBe(unknown.id);
  });

  it('should throw 413 when all enabled routes are too small for the request', () => {
    const db = getDb();
    db.prepare('UPDATE fallback_config SET enabled = 0').run();

    addTestModel(db, {
      platform: 'google',
      modelId: 'test-context-too-small-google',
      rank: 1,
      priority: 1,
      contextWindow: 1000,
    });
    addTestModel(db, {
      platform: 'groq',
      modelId: 'test-context-too-small-groq',
      rank: 2,
      priority: 2,
      contextWindow: 1500,
    });
    addHealthyKey(db, 'google');
    addHealthyKey(db, 'groq');

    let thrown: any;
    try {
      routeRequest({ estimatedTokens: 2000 });
    } catch (err) {
      thrown = err;
    }

    expect(thrown?.status).toBe(413);
    expect(thrown?.message).toMatch(/context/i);
  });

  it('should preserve quality before using distant larger-context fallback for sticky sessions', () => {
    const db = getDb();
    db.prepare('UPDATE fallback_config SET enabled = 0').run();

    const sticky = addTestModel(db, {
      platform: 'groq',
      modelId: 'test-context-sticky-small',
      rank: 1,
      priority: 1,
      contextWindow: 1000,
    });
    const weakButEarlier = addTestModel(db, {
      platform: 'groq',
      modelId: 'test-context-weak-large',
      rank: 10,
      priority: 2,
      contextWindow: 128_000,
    });
    const nearbyButLater = addTestModel(db, {
      platform: 'groq',
      modelId: 'test-context-nearby-large',
      rank: 3,
      priority: 3,
      contextWindow: 128_000,
    });
    addHealthyKey(db, 'groq');

    const result = routeRequest({
      estimatedTokens: 2000,
      preferredModelDbId: sticky.id,
      preferredModelSource: 'sticky',
    });

    expect(result.modelDbId).toBe(nearbyButLater.id);
    expect(result.modelDbId).not.toBe(weakButEarlier.id);
  });

  it('should not leave explicit allowed models when the requested model is too small', () => {
    const db = getDb();
    db.prepare('UPDATE fallback_config SET enabled = 0').run();

    const explicit = addTestModel(db, {
      platform: 'groq',
      modelId: 'test-context-explicit-small',
      rank: 1,
      priority: 1,
      contextWindow: 1000,
    });
    addTestModel(db, {
      platform: 'groq',
      modelId: 'test-context-explicit-replacement',
      rank: 2,
      priority: 2,
      contextWindow: 128_000,
    });
    addHealthyKey(db, 'groq');

    let thrown: any;
    try {
      routeRequest({
        estimatedTokens: 2000,
        preferredModelDbId: explicit.id,
        preferredModelSource: 'explicit',
        allowedModelIds: new Set([explicit.id]),
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown?.status).toBe(413);
  });

});
