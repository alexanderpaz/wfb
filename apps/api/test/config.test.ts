import { describe, expect, it } from 'vitest';
import { testConfig } from './helpers.js';

describe('public URL', () => {
  it('prefers PUBLIC_URL over the Coolify-provided APP_URL', () => {
    const config = testConfig({
      PUBLIC_URL: 'https://files.example.com/',
      APP_URL: 'https://app-abc123.apps.example.com',
      OIDC_ISSUER: 'https://auth.example.com/application/o/wfb/',
      OIDC_CLIENT_ID: 'wfb',
    });
    expect(config.appUrl).toBe('https://files.example.com');
    expect(config.oidc?.redirectUri).toBe('https://files.example.com/api/auth/oidc/callback');
  });

  it('falls back to APP_URL, then SERVICE_URL_APP', () => {
    expect(testConfig({ APP_URL: 'https://a.example.com' }).appUrl).toBe('https://a.example.com');
    expect(testConfig({ PUBLIC_URL: '', SERVICE_URL_APP: 'https://b.example.com' }).appUrl).toBe(
      'https://b.example.com',
    );
  });
});
