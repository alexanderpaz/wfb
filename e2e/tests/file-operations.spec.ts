import { expect, test } from '@playwright/test';
import { item, ldapUsers, loginLdap, openShare, uniqueName } from './helpers';

test.beforeEach(async ({ page }) => {
  await loginLdap(page, ldapUsers.bob);
  await openShare(page, 'Ingeniería');
  await expect(item(page, 'Proyectos')).toBeVisible();
});

test('create, rename and delete a folder', async ({ page }) => {
  const name = uniqueName('Carpeta');
  const renamed = `${name} renombrada`;

  await item(page, 'Proyectos').click();
  await page.keyboard.press('Control+Shift+N');
  const input = page.getByRole('textbox', { name: 'Nuevo nombre' });
  await expect(input).toBeVisible();
  await input.fill(name);
  await input.press('Enter');
  await expect(item(page, name)).toBeVisible();

  await item(page, name).click();
  await page.keyboard.press('F2');
  await page.getByRole('textbox', { name: 'Nuevo nombre' }).fill(renamed);
  await page.keyboard.press('Enter');
  await expect(item(page, renamed)).toBeVisible();
  await expect(item(page, name)).toHaveCount(0);

  await item(page, renamed).click();
  await page.keyboard.press('Delete');
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: /Mover a la papelera|Eliminar/ }).click();
  await expect(item(page, renamed)).toHaveCount(0);
});

test('copy and paste a file into another folder with the keyboard', async ({ page }) => {
  await item(page, 'diagrama.txt').click();
  await page.keyboard.press('Control+C');
  await item(page, 'Proyectos').dblclick();
  await item(page, 'Alfa').dblclick();
  await expect(item(page, 'README.md')).toBeVisible();
  await page.getByRole('listbox').click({ position: { x: 5, y: 200 } });
  await page.keyboard.press('Control+V');
  await expect(item(page, 'diagrama.txt')).toBeVisible();

  const res = await page.request.get('/api/files?share=engineering&path=/');
  const root = await res.json();
  expect(root.entries.map((e: { name: string }) => e.name)).toContain('diagrama.txt');
});

test('pasting onto an existing name offers the conflict dialog', async ({ page }) => {
  await item(page, 'Proyectos').dblclick();
  await item(page, 'Alfa').dblclick();
  await expect(item(page, 'README.md')).toBeVisible();
  const name = uniqueName('dup') + '.txt';
  await page
    .locator('input[type="file"]')
    .setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from('a') });
  await expect(item(page, name)).toBeVisible();
  await item(page, name).click();
  await page.keyboard.press('Control+C');
  await page.getByRole('listbox').click({ position: { x: 5, y: 250 } });
  await page.keyboard.press('Control+V');
  // Windows-like: copy into the same folder renames automatically.
  await expect(item(page, name.replace('.txt', ' (1).txt'))).toBeVisible();

  await page.getByRole('button', { name: 'Atrás' }).click();
  await item(page, 'Beta').dblclick();
  await page
    .locator('input[type="file"]')
    .setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from('b') });
  await expect(item(page, name)).toBeVisible();
  await page.getByRole('listbox').click({ position: { x: 5, y: 250 } });
  await page.keyboard.press('Control+V');
  const dialog = page.getByRole('dialog', { name: 'Reemplazar u omitir archivos' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: /Conservar ambos/ }).click();
  await expect(item(page, name.replace('.txt', ' (1).txt'))).toBeVisible();
});

test('cut and paste moves a file between folders', async ({ page }) => {
  await item(page, 'Proyectos').dblclick();
  await item(page, 'Beta').dblclick();
  const name = uniqueName('mover') + '.txt';
  await page
    .locator('input[type="file"]')
    .setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from('m') });
  await expect(item(page, name)).toBeVisible();
  await item(page, name).click();
  await page.keyboard.press('Control+X');
  await page.getByRole('button', { name: 'Subir un nivel' }).click();
  await item(page, 'Alfa').dblclick();
  await expect(item(page, 'README.md')).toBeVisible();
  await page.getByRole('listbox').click({ position: { x: 5, y: 250 } });
  await page.keyboard.press('Control+V');
  await expect(item(page, name)).toBeVisible();

  const beta = await (await page.request.get('/api/files?share=engineering&path=/Proyectos/Beta')).json();
  expect(beta.entries.map((e: { name: string }) => e.name)).not.toContain(name);
});

test('read-only public share disables write actions', async ({ page }) => {
  await openShare(page, 'Público');
  await expect(item(page, 'Bienvenida.txt')).toBeVisible();
  await item(page, 'Bienvenida.txt').click();
  await expect(page.getByRole('button', { name: 'Eliminar' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Renombrar' })).toBeDisabled();
  const { csrfToken } = await (await page.request.get('/api/auth/me')).json();
  const res = await page.request.post('/api/files/mkdir', {
    data: { share: 'public', path: '/', name: 'x' },
    headers: { 'x-csrf-token': csrfToken },
    failOnStatusCode: false,
  });
  expect(res.status()).toBe(403);
  expect((await res.json()).error.code).toBe('FORBIDDEN');
});

test('download returns file content', async ({ page }) => {
  const res = await page.request.get('/api/files/download?share=engineering&path=/diagrama.txt');
  expect(res.status()).toBe(200);
  expect(await res.text()).toBe('diagrama\n');
  expect(res.headers()['content-disposition']).toContain('attachment');
});
