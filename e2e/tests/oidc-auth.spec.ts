import { expect, test } from '@playwright/test';
import { loginOidc, oidcUsers, shareTree } from './helpers';

test('Authentik user in engineering group sees engineering share', async ({ page }) => {
  await loginOidc(page, oidcUsers.dave);
  const tree = shareTree(page);
  await expect(tree.getByRole('treeitem', { name: 'Ingeniería', exact: true })).toBeVisible();
  await expect(tree.getByRole('treeitem', { name: 'Público', exact: true })).toBeVisible();
  await expect(tree.getByRole('treeitem', { name: 'Finanzas', exact: true })).toHaveCount(0);

  const me = await (await page.request.get('/api/auth/me')).json();
  expect(me.user.provider).toBe('oidc');
  expect(me.user.groups).toContain('engineering');
});

test('Authentik user in finance group sees finance share', async ({ page }) => {
  await loginOidc(page, oidcUsers.erin);
  const tree = shareTree(page);
  await expect(tree.getByRole('treeitem', { name: 'Finanzas', exact: true })).toBeVisible();
  await expect(tree.getByRole('treeitem', { name: 'Ingeniería', exact: true })).toHaveCount(0);
});
