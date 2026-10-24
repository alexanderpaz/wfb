import type { AuthProvidersResponse } from '@wfb/contracts';
import { API_PREFIX } from '@wfb/contracts';
import fp from 'fastify-plugin';
import type { ModuleOptions } from '../lib/module.js';

/**
 * Auth module: sessions, CSRF, LDAP/AD and OIDC login.
 * Placeholder from Phase 0 — implemented by the Auth agent (Phase 1).
 */
export default fp<ModuleOptions>(
  async (app) => {
    app.get(`${API_PREFIX}/auth/providers`, async (): Promise<AuthProvidersResponse> => ({
      directory: null,
      oidc: null,
    }));
  },
  { name: 'wfb-auth' },
);
