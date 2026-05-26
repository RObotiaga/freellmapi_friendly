import { Router } from 'express';
import type { Request, Response } from 'express';

import { adminAuth } from '../middleware/adminAuth.js';
import { configureAdminTokenFromSetup, getAdminSetupStatus } from '../services/adminToken.js';

export const adminRouter = Router();

adminRouter.get('/setup-status', (_req: Request, res: Response) => {
  res.json(getAdminSetupStatus());
});

adminRouter.post('/setup', (req: Request, res: Response) => {
  const status = getAdminSetupStatus();

  if (status.mode === 'configured') {
    res.status(409).json({
      error: {
        message: 'Admin Token is already configured.',
        type: 'admin_already_configured',
      },
    });
    return;
  }

  if (status.mode === 'expired') {
    res.status(410).json({
      error: {
        message: status.reason ?? 'First-run setup window expired.',
        type: 'admin_setup_expired',
      },
    });
    return;
  }

  if (status.mode !== 'ready') {
    res.status(403).json({
      error: {
        message: status.reason ?? 'First-run setup is not available.',
        type: 'admin_setup_unavailable',
      },
    });
    return;
  }

  const token = req.body?.token;
  const configured = configureAdminTokenFromSetup(token);

  res.status(201).json({
    configured: configured.mode === 'configured',
  });
});

adminRouter.get('/session', adminAuth, (_req: Request, res: Response) => {
  res.json({ authenticated: true });
});
