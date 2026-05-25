import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  getAutoretryEnabled,
  getUnifiedApiKey,
  regenerateUnifiedKey,
  setAutoretryEnabled,
} from '../db/index.js';

export const settingsRouter = Router();

const autoretrySchema = z.object({
  enabled: z.boolean(),
});

// Get the unified API key
settingsRouter.get('/api-key', (_req: Request, res: Response) => {
  res.json({ apiKey: getUnifiedApiKey() });
});

// Regenerate the unified API key
settingsRouter.post('/api-key/regenerate', (_req: Request, res: Response) => {
  const newKey = regenerateUnifiedKey();
  res.json({ apiKey: newKey });
});

settingsRouter.get('/autoretry', (_req: Request, res: Response) => {
  res.json({ enabled: getAutoretryEnabled() });
});

settingsRouter.patch('/autoretry', (req: Request, res: Response) => {
  const parsed = autoretrySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  setAutoretryEnabled(parsed.data.enabled);
  res.json({ enabled: getAutoretryEnabled() });
});
