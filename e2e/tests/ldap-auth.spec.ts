import { expect, test } from '@playwright/test';
import { ldapUsers, loginLdap, shareTree } from './helpers';

test('rejects a wrong password', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Usuario').fill('alice');
  await page.getByLabel('Contraseña').fill('incorrecta');
  await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('incorrectos');
});

test('engineering member sees public, engineering and home shares only', async ({ page }) => {
  await loginLdap(page, ldapUsers.bob);
  const tree = shareTree(page);
  await expect(tree.getByRole('treeitem', { name: 'Público', exact: true })).toBeVisible();
  await expect(tree.getByRole('treeitem', { name: 'Ingeniería', exact: true })).toBeVisible();
  await expect(tree.getByRole('treeitem', { name: 'Mi carpeta', exact: true })).toBeVisible();
  await expect(tree.getByRole('treeitem', { name: 'Finanzas', exact: true })).toHaveCount(0);
});

test('finance member sees finance but not engineering', async ({ page }) => {
  await loginLdap(page, ldapUsers.carol);
  const tree = shareTree(page);
  await expect(tree.getByRole('treeitem', { name: 'Finanzas', exact: true })).toBeVisible();
  await expect(tree.getByRole('treeitem', { name: 'Ingeniería', exact: true })).toHaveCount(0);
});

test('a private share cannot be reached through the URL', async ({ page }) => {
  await loginLdap(page, ldapUsers.carol);
  const res = await page.request.get('/api/files?share=engineering&path=/');
  expect(res.status()).toBe(404);
});

test('logout returns to the login page and invalidates the session', async ({ page }) => {
  await loginLdap(page, ldapUsers.alice);
  await page.getByRole('button', { name: ldapUsers.alice.displayName }).click();
  await page.getByRole('button', { name: 'Cerrar sesión' }).click();
  await expect(page.getByRole('button', { name: 'Iniciar sesión', exact: true })).toBeVisible();
  const res = await page.request.get('/api/auth/me');
  expect(res.status()).toBe(401);
});
