/**
 * The /login page (docs/06 §4.2 steps 3-4): the human half of the OAuth
 * flow. There is no web session — the "session" IS the pending authorization
 * transaction (txn) created by provider.authorize(), with its own CSRF token
 * and a 10-minute TTL. Success consumes the transaction and redirects to the
 * client's registered redirect_uri with the single-use code.
 */

import { timingSafeEqual } from 'node:crypto';

import express, { Router, type Request, type Response } from 'express';
import { rateLimit, type Options as RateLimitOptions } from 'express-rate-limit';

import { AccessDeniedError } from '@modelcontextprotocol/sdk/server/auth/errors.js';

import type { UserStore } from '../users/store.js';
import type { UntacitOAuthProvider } from './provider.js';
import { renderErrorPage, renderLoginPage } from './pages.js';

export interface LoginRouterOptions {
  provider: UntacitOAuthProvider;
  users: UserStore;
  /** Rate limit for POST /login; false disables it (tests). */
  rateLimit?: Partial<RateLimitOptions> | false;
}

const GENERIC_LOGIN_ERROR = 'Wrong username or password.';

function securityHeaders(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // The txn id must never leak through the Referer of an off-site navigation.
  res.setHeader('Referrer-Policy', 'no-referrer');
}

function expiredTransaction(res: Response): void {
  res
    .status(400)
    .send(
      renderErrorPage(
        'Sign-in link expired',
        'This sign-in request is unknown or has expired. Go back to your MCP client and connect again.',
      ),
    );
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

export function loginRouter(opts: LoginRouterOptions): Router {
  const router = Router();

  router.get('/login', (req: Request, res: Response) => {
    securityHeaders(res);
    const txnId = typeof req.query.txn === 'string' ? req.query.txn : '';
    const txn = txnId !== '' ? opts.provider.getAuthRequest(txnId) : undefined;
    if (!txn) {
      expiredTransaction(res);
      return;
    }
    const client = opts.provider.clientsStore.getClient(txn.clientId);
    res.send(renderLoginPage({ txnId: txn.txnId, csrf: txn.csrf, clientName: client?.client_name }));
  });

  const limiter =
    opts.rateLimit === false
      ? undefined
      : rateLimit({
          windowMs: 15 * 60 * 1000,
          limit: 20,
          standardHeaders: true,
          legacyHeaders: false,
          handler: (_req, res) => {
            securityHeaders(res);
            res
              .status(429)
              .send(renderErrorPage('Too many attempts', 'Too many sign-in attempts. Try again in a few minutes.'));
          },
          ...opts.rateLimit,
        });

  const postHandlers: express.RequestHandler[] = [express.urlencoded({ extended: false })];
  if (limiter) postHandlers.push(limiter);

  router.post('/login', ...postHandlers, (req: Request, res: Response) => {
    securityHeaders(res);
    const body = req.body as Record<string, unknown>;
    const txnId = typeof body.txn === 'string' ? body.txn : '';
    const csrf = typeof body.csrf === 'string' ? body.csrf : '';
    const username = typeof body.username === 'string' ? body.username : '';
    const password = typeof body.password === 'string' ? body.password : '';

    const txn = txnId !== '' ? opts.provider.getAuthRequest(txnId) : undefined;
    if (!txn) {
      expiredTransaction(res);
      return;
    }
    if (!safeEqual(csrf, txn.csrf)) {
      // A mismatched CSRF token is a cross-site post, not a typo — refuse
      // without re-rendering the form for the attacker.
      res.status(400).send(renderErrorPage('Invalid request', 'Cross-site request rejected. Start over from your MCP client.'));
      return;
    }

    const user = opts.users.verifyCredentials(username, password);
    if (!user) {
      // One generic message for unknown user, wrong password and disabled
      // account — no enumeration (docs/06 §12).
      const client = opts.provider.clientsStore.getClient(txn.clientId);
      res
        .status(200)
        .send(
          renderLoginPage({
            txnId: txn.txnId,
            csrf: txn.csrf,
            clientName: client?.client_name,
            error: GENERIC_LOGIN_ERROR,
          }),
        );
      return;
    }

    try {
      const redirectUrl = opts.provider.issueAuthorizationCode(txn, user.id);
      res.redirect(302, redirectUrl);
    } catch (err) {
      if (err instanceof AccessDeniedError) {
        // Authenticated but not authorized (no grant on the requested graph,
        // or a double submit): a human-readable page beats an OAuth error.
        res
          .status(403)
          .send(
            renderErrorPage(
              'No access',
              'Your account has no access to this graph. Ask your untacit administrator for a grant.',
            ),
          );
        return;
      }
      throw err;
    }
  });

  return router;
}
