import cookie from '@fastify/cookie';
import type { FastifyPluginAsync } from 'fastify';
import { authRoutes } from './auth.js';
import { endpointRoutes } from './endpoints.js';
import { githubOauthRoutes } from './oauth.js';

/**
 * VIEWER PATH — the authenticated dashboard API, registered under /api.
 * Cookies and JSON parsing live only in this scope; the ingest path
 * never pays for (or trusts) either.
 */
export const apiRoutes: FastifyPluginAsync = async (app) => {
  await app.register(cookie);

  app.decorateRequest('user', null);

  await app.register(authRoutes, { prefix: '/auth' });
  await app.register(githubOauthRoutes, { prefix: '/auth' });
  await app.register(endpointRoutes, { prefix: '/endpoints' });
};
