import type { NextFunction, Request, Response } from 'express';

import { hasConfiguredAdminToken, verifyAdminToken } from '../services/adminToken.js';

export function adminAuth(req: Request, res: Response, next: NextFunction) {
  if (!hasConfiguredAdminToken()) {
    res.status(503).json({
      error: {
        message: 'Admin API is locked because ADMIN_TOKEN is not configured.',
        type: 'admin_locked',
      },
    });
    return;
  }

  const token = readBearerToken(req.header('authorization'));
  if (!token || !verifyAdminToken(token)) {
    res.status(401).json({
      error: {
        message: 'Admin authentication required.',
        type: 'admin_auth_required',
      },
    });
    return;
  }

  next();
}

function readBearerToken(header: string | undefined): string | null {
  if (!header) return null;

  const match = /^Bearer\s+(.+)$/.exec(header);
  return match?.[1] ?? null;
}
