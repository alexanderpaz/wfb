import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { forbidden, publicErrorMessage } from '../../src/lib/errors.js';
import { createFixture, users, type Fixture } from '../files/fixture.js';

describe('error responses do not leak server paths', () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await createFixture();
  });
  afterEach(() => fx.cleanup());

  it('maps file system errors to generic messages', async () => {
    await fx.file('public/a.txt');
    const app = await fx.app(users.alice);
    const res = await app.inject({ method: 'GET', url: '/api/files?share=public&path=/a.txt' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe('Not a folder');
    expect(res.body).not.toContain(fx.root);
  });

  it('reduces errno errors to their code', () => {
    const err = Object.assign(new Error("ENOSPC: no space left on device, write '/srv/shares/x'"), {
      code: 'ENOSPC',
      syscall: 'write',
      path: '/srv/shares/x',
    });
    expect(publicErrorMessage(err)).toBe('ENOSPC');
    const notDir = Object.assign(new Error("ENOTDIR: not a directory, scandir '/srv/a'"), {
      code: 'ENOTDIR',
      syscall: 'scandir',
    });
    expect(publicErrorMessage(notDir)).toBe('Not a folder');
    expect(publicErrorMessage(forbidden('nope'))).toBe('nope');
    expect(publicErrorMessage(new Error('disk full'))).toBe('disk full');
    expect(publicErrorMessage(undefined)).toBe('failed');
  });
});
