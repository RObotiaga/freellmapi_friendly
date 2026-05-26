import { Router } from 'express';
import type { Request, Response } from 'express';

import { getDb } from '../db/index.js';

export const modelsRouter = Router();

// Public model catalog. Keep this route free of runtime Provider capability,
// Provider Key availability, fallback priority, and fallback enablement.
modelsRouter.get('/', (_req: Request, res: Response) => {
  const db = getDb();

  const models = db.prepare(`
    SELECT
      id,
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
    FROM models
    ORDER BY intelligence_rank ASC, speed_rank ASC, display_name ASC
  `).all() as any[];

  const result = models.map(m => ({
    id: m.id,
    platform: m.platform,
    modelId: m.model_id,
    displayName: m.display_name,
    intelligenceRank: m.intelligence_rank,
    speedRank: m.speed_rank,
    sizeLabel: m.size_label,
    rpmLimit: m.rpm_limit,
    rpdLimit: m.rpd_limit,
    tpmLimit: m.tpm_limit,
    tpdLimit: m.tpd_limit,
    monthlyTokenBudget: m.monthly_token_budget,
    contextWindow: m.context_window,
    enabled: m.enabled === 1,
  }));

  res.json(result);
});
