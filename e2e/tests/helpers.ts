import { expect, type Page } from '@playwright/test';

export const ldapUsers = {
  alice: { username: 'alice', password: 'alice123', displayName: 'Alice Admin' },
  bob: { username: 'bob', password: 'bob123', displayName: 'Bob Builder' },
  carol: { username: 'carol', password: 'carol123', displayName: 'Carol Contable' },
} as const;

export const oidcUsers = {
  dave: { username: 'dave', password: 'dave12345', displayName: 'Dave Dev' },
  erin: { username: 'erin', password: 'erin12345', displayName: 'Erin Finance' },
} as const;

export async function loginLdap(
  page: Page,
  user: { username: string; password: string; displayName: string },
) {
  await page.goto('/');
  await page.getByLabel('Usuario').fill(user.username);
  await page.getByLabel('Contraseña').fill(user.password);
  await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
  await expect(page.getByRole('button', { name: user.displayName })).toBeVisible();
}

export async function loginOidc(
  page: Page,
  user: { username: string; password: string; displayName: string },
) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Iniciar sesión con Authentik' }).click();
  await page.waitForURL(/localhost:9000/);
  await page.locator('input[name="uidField"]').fill(user.username);
  await page.locator('button[type="submit"]').click();
  // The password stage is rendered after the identification stage round-trip.
  const password = page.locator('input[name="password"]:visible');
  await expect(password).toBeEditable();
  await expect(page.getByText(user.username, { exact: true })).toBeVisible();
  await password.fill(user.password);
  await password.press('Enter');
  await page.waitForURL((url) => url.port !== '9000', { timeout: 30_000 });
  await expect(page.getByRole('button', { name: user.displayName })).toBeVisible({ timeout: 20_000 });
}

export function shareTree(page: Page) {
  return page.getByRole('tree', { name: 'Recursos compartidos' });
}

export async function openShare(page: Page, name: string) {
  await shareTree(page).getByRole('treeitem', { name, exact: true }).first().click();
}

export function item(page: Page, name: string) {
  return page.getByRole('listbox').getByRole('option', { name, exact: true });
}

export function uniqueName(prefix: string) {
  return `${prefix} ${Date.now().toString(36)}`;
}
