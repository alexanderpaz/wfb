import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { Blob as NodeBlob, File as NodeFile } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../mocks/db';
import { server } from '../../mocks/server';
import { transferCancel, useTransfers } from '../../stores/transfers';
import { renderExplorer, setupMockApi } from './test-utils';

setupMockApi();

const MB = 1024 * 1024;
const ENG = '/?share=engineering&path=/';

const option = (name: string) => screen.findByRole('option', { name });
const names = () => screen.getAllByRole('option').map((o) => o.getAttribute('aria-label'));

beforeEach(() => {
  useTransfers.setState({ tasks: [], collapsed: false });
  transferCancel.clear();
});
afterEach(() => {
  for (const j of db.jobs.values()) if (j.timer) clearTimeout(j.timer);
});

async function openEngineering() {
  const r = renderExplorer({}, ENG);
  await option('Proyectos');
  return r;
}

/** Copies "Multimedia" (~22 MB) into "Proyectos" with Ctrl+C / Ctrl+V. */
async function copyMultimediaIntoProyectos(user: Awaited<ReturnType<typeof openEngineering>>['user']) {
  await user.click(screen.getByRole('option', { name: 'Multimedia' }));
  await user.keyboard('{Control>}c{/Control}');
  await user.dblClick(screen.getByRole('option', { name: 'Proyectos' }));
  await option('Alfa');
  await user.keyboard('{Control>}v{/Control}');
}

describe('background jobs panel', () => {
  it('shows progress for large copies and refreshes the destination when done', async () => {
    db.jobSettings = { syncLimitBytes: MB, bytesPerTick: 6 * MB, tickMs: 40 };
    const { user } = await openEngineering();
    await copyMultimediaIntoProyectos(user);

    const panel = await screen.findByRole('region', { name: 'Operaciones en segundo plano' });
    const task = within(panel).getByRole('listitem', {
      name: 'Copiando 1 elemento de Ingeniería a Proyectos',
    });
    expect(within(task).getByRole('progressbar')).toBeInTheDocument();
    await waitFor(() => expect(within(task).getByText('Completado')).toBeInTheDocument(), { timeout: 3000 });
    expect(within(task).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
    expect(await option('Multimedia')).toBeInTheDocument();
    expect(names()).toEqual(['Alfa', 'Beta', 'Multimedia']);

    await user.click(within(panel).getByRole('button', { name: 'Cerrar panel de operaciones' }));
    expect(screen.queryByRole('region', { name: 'Operaciones en segundo plano' })).not.toBeInTheDocument();
  });

  it('reports intermediate progress with bytes and the current item', async () => {
    db.jobSettings = { syncLimitBytes: MB, bytesPerTick: 4 * MB, tickMs: 150 };
    const { user } = await openEngineering();
    await copyMultimediaIntoProyectos(user);
    const task = await screen.findByRole('listitem', { name: /^Copiando 1 elemento/ });
    await waitFor(() => expect(within(task).getByText(/^\d+ % completado$/)).toBeInTheDocument());
    await waitFor(() => expect(within(task).getByText(/de 21 MB/)).toBeInTheDocument());
    expect(within(task).getByText('Elemento: Multimedia')).toBeInTheDocument();
    await waitFor(() => expect(within(task).getByText('Completado')).toBeInTheDocument(), { timeout: 4000 });
  });

  it('cancels a running job', async () => {
    db.jobSettings = { syncLimitBytes: MB, bytesPerTick: 1024, tickMs: 50 };
    const { user } = await openEngineering();
    await copyMultimediaIntoProyectos(user);
    const task = await screen.findByRole('listitem', { name: /^Copiando 1 elemento/ });
    await user.click(within(task).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(within(task).getByText('Cancelado')).toBeInTheDocument());
    expect(within(task).queryByRole('button', { name: 'Cancelar' })).not.toBeInTheDocument();
    expect([...db.jobs.values()][0]!.job.status).toBe('cancelled');
    expect(names()).toEqual(['Alfa', 'Beta']);
  });

  it('collapses and stacks several operations', async () => {
    db.jobSettings = { syncLimitBytes: MB, bytesPerTick: 1024, tickMs: 50 };
    const { user } = await openEngineering();
    await user.click(screen.getByRole('option', { name: 'Multimedia' }));
    await user.keyboard('{Control>}c{/Control}');
    await user.dblClick(screen.getByRole('option', { name: 'Proyectos' }));
    await option('Alfa');
    await user.keyboard('{Control>}v{/Control}');
    await screen.findByRole('listitem', { name: /a Proyectos$/ });
    await user.dblClick(screen.getByRole('option', { name: 'Alfa' }));
    await option('src');
    await user.keyboard('{Control>}v{/Control}');
    await screen.findByRole('listitem', { name: /a Alfa$/ });

    const panel = screen.getByRole('region', { name: 'Operaciones en segundo plano' });
    const toggle = within(panel).getByRole('button', { name: '2 operaciones en curso' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await user.click(toggle);
    expect(within(panel).queryAllByRole('listitem')).toHaveLength(0);
    await user.click(toggle);
    expect(within(panel).getAllByRole('listitem')).toHaveLength(2);
  });

  it('shows per-item failures of a finished job', async () => {
    server.use(
      http.get('*/api/jobs/:id/events', () => {
        const job = {
          id: 'job-x',
          kind: 'move',
          status: 'completed',
          totalBytes: 10,
          doneBytes: 10,
          totalItems: 2,
          doneItems: 2,
          currentItem: null,
          error: null,
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
          results: [
            {
              source: { share: 'engineering', path: '/notas.txt' },
              status: 'done',
              target: null,
              error: null,
            },
            {
              source: { share: 'engineering', path: '/config.json' },
              status: 'failed',
              target: null,
              error: 'forbidden',
            },
          ],
        };
        return new HttpResponse(`data: ${JSON.stringify(job)}\n\n`, {
          headers: { 'content-type': 'text/event-stream' },
        });
      }),
      http.post('*/api/files/move', () => HttpResponse.json({ mode: 'job', jobId: 'job-x' })),
    );
    const { user } = await openEngineering();
    await user.click(screen.getByRole('option', { name: 'config.json' }));
    await user.keyboard('{Control>}x{/Control}');
    await user.dblClick(screen.getByRole('option', { name: 'Vacía' }));
    await screen.findByText('Esta carpeta está vacía.');
    await user.keyboard('{Control>}v{/Control}');
    const task = await screen.findByRole('listitem', { name: /^Moviendo/ });
    await waitFor(() => expect(within(task).getByText('1 elemento no se pudo procesar')).toBeInTheDocument());
    expect(within(task).getByText('config.json')).toBeInTheDocument();
    expect(within(task).getByText('forbidden')).toBeInTheDocument();
  });
});

describe('trash view', () => {
  async function trashTwo(user: Awaited<ReturnType<typeof openEngineering>>['user']) {
    await user.click(screen.getByRole('option', { name: 'notas.txt' }));
    await user.keyboard('{Delete}');
    await user.click(await screen.findByRole('button', { name: 'Mover a la papelera' }));
    await waitFor(() => expect(screen.queryByRole('option', { name: 'notas.txt' })).not.toBeInTheDocument());
    await user.click(screen.getByRole('option', { name: 'config.json' }));
    await user.keyboard('{Delete}');
    await user.click(await screen.findByRole('button', { name: 'Mover a la papelera' }));
    await waitFor(() =>
      expect(screen.queryByRole('option', { name: 'config.json' })).not.toBeInTheDocument(),
    );
  }

  async function openTrash(user: Awaited<ReturnType<typeof openEngineering>>['user']) {
    const tree = screen.getByRole('tree');
    const root = within(tree).getByRole('treeitem', { name: 'Papelera de reciclaje' });
    // Only shares with delete permission get a recycle bin.
    await user.click(root.querySelector('.wfb-tree-row')!);
    expect(within(tree).queryByRole('treeitem', { name: 'Papelera de Público' })).not.toBeInTheDocument();
    await user.click(
      within(tree).getByRole('treeitem', { name: 'Papelera de Ingeniería' }).firstElementChild!,
    );
    return screen.findByRole('listbox', { name: 'Papelera de Ingeniería' });
  }

  it('lists trashed items and restores them', async () => {
    const { user } = await openEngineering();
    await trashTwo(user);
    const list = await openTrash(user);
    expect(window.location.search).toContain('view=trash');
    await waitFor(() => expect(within(list).getAllByRole('option')).toHaveLength(2));
    const row = within(list).getByRole('option', { name: 'notas.txt' });
    expect(row).toHaveTextContent('Ingeniería');
    expect(screen.getByText('Ubicación original')).toBeInTheDocument();
    expect(screen.getByText('Fecha de eliminación')).toBeInTheDocument();

    await user.click(row);
    await user.click(screen.getByRole('button', { name: 'Restaurar' }));
    expect(await screen.findByText('Se ha restaurado «notas.txt»')).toBeInTheDocument();
    await waitFor(() =>
      expect(
        within(list)
          .getAllByRole('option')
          .map((o) => o.ariaLabel),
      ).toEqual(['config.json']),
    );

    await user.click(screen.getByRole('button', { name: 'Atrás' }));
    expect(await option('notas.txt')).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'config.json' })).not.toBeInTheDocument();
  });

  it('purges selected items and empties the trash after confirmation', async () => {
    const { user } = await openEngineering();
    await trashTwo(user);
    const list = await openTrash(user);
    await user.click(await within(list).findByRole('option', { name: 'config.json' }));
    await user.click(screen.getByRole('button', { name: 'Eliminar permanentemente' }));
    let dialog = await screen.findByRole('dialog', { name: 'Eliminar permanentemente' });
    expect(dialog).toHaveTextContent('«config.json»');
    await user.click(within(dialog).getByRole('button', { name: 'Eliminar' }));
    await waitFor(() => expect(within(list).getAllByRole('option')).toHaveLength(1));

    await user.click(screen.getByRole('button', { name: 'Vaciar papelera' }));
    dialog = await screen.findByRole('dialog', { name: 'Vaciar papelera' });
    await user.click(within(dialog).getByRole('button', { name: 'Eliminar' }));
    expect(await screen.findByText('La papelera está vacía.')).toBeInTheDocument();
    expect(db.trash.get('engineering')).toEqual([]);
  });

  it('deletes permanently with Shift+Delete, bypassing the trash', async () => {
    const { user } = await openEngineering();
    await user.click(screen.getByRole('option', { name: 'notas.txt' }));
    await user.keyboard('{Shift>}{Delete}{/Shift}');
    const dialog = await screen.findByRole('dialog', { name: 'Eliminar archivo' });
    await user.click(within(dialog).getByRole('button', { name: 'Eliminar' }));
    await waitFor(() => expect(screen.queryByRole('option', { name: 'notas.txt' })).not.toBeInTheDocument());
    expect(db.trash.get('engineering') ?? []).toEqual([]);
  });
});

describe('recursive search', () => {
  it('shows server results after a pause and opens folders from them', async () => {
    const { user } = await openEngineering();
    await user.type(screen.getByRole('searchbox', { name: 'Buscar en Ingeniería' }), 'src');
    const results = await screen.findByRole(
      'listbox',
      { name: 'Resultados de búsqueda en Ingeniería' },
      { timeout: 2000 },
    );
    const row = await within(results).findByRole('option', { name: 'src' });
    expect(row).toHaveTextContent('Ingeniería/Proyectos/Alfa');
    expect(screen.getByText('Carpeta')).toBeInTheDocument();

    await user.dblClick(row);
    expect(await option('index.ts')).toBeInTheDocument();
    expect(window.location.search).toContain('path=%2FProyectos%2FAlfa%2Fsrc');
    expect(screen.getByRole('searchbox', { name: 'Buscar en src' })).toHaveValue('');
  });

  it('searches on Enter (accent-insensitive) and Escape returns to the folder', async () => {
    const { user } = await openEngineering();
    const box = screen.getByRole('searchbox', { name: 'Buscar en Ingeniería' });
    await user.type(box, 'E{Enter}');
    const results = await screen.findByRole('listbox', { name: 'Resultados de búsqueda en Ingeniería' });
    await waitFor(() => expect(within(results).getAllByRole('option').length).toBeGreaterThan(3));

    await user.clear(box);
    await user.type(box, 'especificacion{Enter}');
    expect(await within(results).findByRole('option', { name: 'Especificación.pdf' })).toHaveTextContent(
      'Ingeniería/Documentación',
    );
    await user.keyboard('{Escape}');
    expect(await option('Proyectos')).toBeInTheDocument();
    expect(screen.queryByRole('listbox', { name: /Resultados de búsqueda/ })).not.toBeInTheDocument();
  });

  it('opens files from the results and flags truncated results', async () => {
    server.use(
      http.get('*/api/search', () =>
        HttpResponse.json({
          results: [
            {
              name: 'README.md',
              path: '/Proyectos/Alfa/README.md',
              type: 'file',
              size: 16,
              modifiedAt: '2026-10-15T09:12:00.000Z',
              mime: 'text/markdown',
              previewable: true,
            },
          ],
          truncated: true,
        }),
      ),
    );
    const opened: string[] = [];
    const r = renderExplorer({ onOpenFile: (e, share) => opened.push(`${share}:${e.path}`) }, ENG);
    await option('Proyectos');
    await r.user.type(screen.getByRole('searchbox', { name: 'Buscar en Ingeniería' }), 'read{Enter}');
    expect(await screen.findByRole('note')).toHaveTextContent('Se muestran solo los primeros 1 resultados');
    await r.user.dblClick(await screen.findByRole('option', { name: 'README.md' }));
    expect(opened).toEqual(['engineering:/Proyectos/Alfa/README.md']);
  });
});

describe('chunked uploads', () => {
  // jsdom's Blob cannot be sent by Node's fetch; use the Node implementation like a browser would.
  beforeEach(() => {
    vi.stubGlobal('Blob', NodeBlob);
    vi.stubGlobal('File', NodeFile);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('uploads large files in chunks with progress in the panel', async () => {
    db.uploadChunkSize = 4 * MB;
    const { user } = await openEngineering();
    const big = new File([new Uint8Array(9 * MB)], 'grande.iso');
    await user.upload(screen.getByTestId('upload-input'), big);
    const task = await screen.findByRole('listitem', { name: 'Subiendo «grande.iso» a Ingeniería' });
    await waitFor(() => expect(within(task).getByText('Completado')).toBeInTheDocument(), { timeout: 5000 });
    expect(await option('grande.iso')).toBeInTheDocument();
    expect(db.uploads.size).toBe(0);
  });
});
