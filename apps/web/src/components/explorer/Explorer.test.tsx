import { act, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { db } from '../../mocks/db';
import { server } from '../../mocks/server';
import { useClipboard } from '../../stores/clipboard';
import { renderExplorer, setupMockApi } from './test-utils';

setupMockApi();

const ENG = '/?share=engineering&path=/';

const names = () => screen.getAllByRole('option').map((o) => o.getAttribute('aria-label'));
const option = (name: string) => screen.findByRole('option', { name });
const status = () => screen.getByRole('contentinfo');

async function openEngineering(props = {}) {
  const r = renderExplorer(props, ENG);
  await option('Proyectos');
  return r;
}

describe('Explorer: loading and navigation', () => {
  it('renders the shares in the tree and the items of the first share', async () => {
    renderExplorer();
    const tree = await screen.findByRole('tree');
    expect(await within(tree).findByRole('treeitem', { name: 'Público' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(within(tree).getByRole('treeitem', { name: 'Ingeniería' })).toBeInTheDocument();
    expect(within(tree).getByRole('treeitem', { name: 'Mi carpeta' })).toBeInTheDocument();
    expect(await option('Manuales')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Logo.png' })).toBeInTheDocument();
    expect(status()).toHaveTextContent('5 elementos');
    expect(window.location.search).toBe('?share=public&path=%2F');
  });

  it('restores the location from the URL and shows type labels and sizes', async () => {
    await openEngineering();
    const row = screen.getByRole('option', { name: 'backup.zip' });
    expect(row).toHaveTextContent('Carpeta comprimida (zip)');
    expect(row).toHaveTextContent('7 MB');
    expect(screen.getByRole('option', { name: 'Proyectos' })).toHaveTextContent('Carpeta de archivos');
  });

  it('navigates into folders by double click and back through the breadcrumbs', async () => {
    const { user } = await openEngineering();
    await user.dblClick(screen.getByRole('option', { name: 'Proyectos' }));
    await user.dblClick(await option('Alfa'));
    expect(await option('src')).toBeInTheDocument();
    expect(window.location.search).toContain('path=%2FProyectos%2FAlfa');

    const crumbs = screen.getByRole('navigation', { name: 'Ruta de navegación' });
    expect(within(crumbs).getByRole('button', { name: 'Alfa' })).toHaveAttribute('aria-current', 'location');
    await user.click(within(crumbs).getByRole('button', { name: 'Proyectos' }));
    expect(await option('Beta')).toBeInTheDocument();
    await user.click(within(crumbs).getByRole('button', { name: 'Ingeniería' }));
    expect(await option('notas.txt')).toBeInTheDocument();
  });

  it('opens folders with Enter and files through onOpenFile', async () => {
    const onOpenFile = vi.fn();
    const { user } = await openEngineering({ onOpenFile });
    await user.dblClick(screen.getByRole('option', { name: 'notas.txt' }));
    expect(onOpenFile).toHaveBeenCalledWith(expect.objectContaining({ path: '/notas.txt' }), 'engineering');
    await user.click(screen.getByRole('option', { name: 'Multimedia' }));
    await user.keyboard('{Enter}');
    expect(await option('demo.mp4')).toBeInTheDocument();
  });

  it('supports back, forward and up (buttons and keyboard)', async () => {
    const { user } = await openEngineering();
    await user.dblClick(screen.getByRole('option', { name: 'Proyectos' }));
    await option('Alfa');
    await user.click(screen.getByRole('button', { name: 'Atrás' }));
    expect(await option('notas.txt')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Adelante' }));
    expect(await option('Alfa')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Adelante' })).toBeDisabled();

    await user.click(screen.getByRole('option', { name: 'Alfa' }));
    await user.keyboard('{Alt>}{ArrowLeft}{/Alt}');
    expect(await option('notas.txt')).toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: 'notas.txt' }));
    await user.keyboard('{Alt>}{ArrowRight}{/Alt}');
    expect(await option('Alfa')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Subir un nivel' }));
    // Going up selects the folder we came from.
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'Proyectos' })).toHaveAttribute('aria-selected', 'true'),
    );
    expect(screen.getByRole('button', { name: 'Subir un nivel' })).toBeDisabled();
  });

  it('navigates from the tree and lazily expands folders', async () => {
    const { user } = await openEngineering();
    const tree = screen.getByRole('tree');
    await user.click(within(tree).getByText('Mi carpeta'));
    expect(await option('Currículum.pdf')).toBeInTheDocument();
    const eng = within(tree).getByRole('treeitem', { name: 'Ingeniería' });
    const proyectos = await within(eng).findByRole('treeitem', { name: 'Proyectos' });
    expect(proyectos).toHaveAttribute('aria-expanded', 'false');
    proyectos.focus();
    await user.keyboard('{ArrowRight}');
    expect(await within(tree).findByRole('treeitem', { name: 'Alfa' })).toBeInTheDocument();
    await user.keyboard('{ArrowDown}{Enter}');
    expect(await option('README.md')).toBeInTheDocument();
    expect(within(tree).getByRole('treeitem', { name: 'Alfa' })).toHaveAttribute('aria-selected', 'true');
  });

  it('accepts a typed /share/path in the address bar', async () => {
    const { user } = await openEngineering();
    await user.click(screen.getByRole('navigation', { name: 'Ruta de navegación' }));
    const input = screen.getByRole('textbox', { name: 'Dirección' });
    expect(input).toHaveValue('/Ingeniería');
    await user.clear(input);
    await user.type(input, '/engineering/Proyectos/Alfa{Enter}');
    expect(await option('README.md')).toBeInTheDocument();
  });

  it('filters the current folder with the search box', async () => {
    const { user } = await openEngineering();
    await user.type(screen.getByRole('searchbox', { name: 'Buscar en Ingeniería' }), 'no');
    expect(names()).toEqual(['notas.txt']);
    expect(status()).toHaveTextContent('1 elemento');
  });

  it('shows the empty folder message', async () => {
    const { user } = await openEngineering();
    await user.dblClick(screen.getByRole('option', { name: 'Vacía' }));
    expect(await screen.findByText('Esta carpeta está vacía.')).toBeInTheDocument();
  });

  it('shows API errors as toasts', async () => {
    server.use(
      http.get('/api/files', () =>
        HttpResponse.json({ error: { code: 'FORBIDDEN', message: 'nope' } }, { status: 403 }),
      ),
    );
    renderExplorer({}, ENG);
    const toast = (await screen.findByText('No se puede abrir la carpeta')).closest('[role="alert"]');
    expect(toast).toHaveTextContent('No tiene permiso para realizar esta operación.');
    expect(screen.getByText('No se puede acceder a esta ubicación')).toBeInTheDocument();
  });
});

describe('Explorer: selection and sorting', () => {
  it('selects with click, ctrl+click, shift+click, Ctrl+A and clears on empty click', async () => {
    const { user } = await openEngineering();
    await user.click(screen.getByRole('option', { name: 'Documentación' }));
    await user.keyboard('{Shift>}');
    await user.click(screen.getByRole('option', { name: 'Vacía' }));
    await user.keyboard('{/Shift}');
    expect(
      screen.getAllByRole('option', { selected: true }).map((o) => o.getAttribute('aria-label')),
    ).toEqual(['Documentación', 'Multimedia', 'Proyectos', 'Vacía']);
    expect(status()).toHaveTextContent('4 elementos seleccionados');

    await user.keyboard('{Control>}');
    await user.click(screen.getByRole('option', { name: 'Multimedia' }));
    await user.click(screen.getByRole('option', { name: 'notas.txt' }));
    await user.keyboard('{/Control}');
    expect(screen.getAllByRole('option', { selected: true })).toHaveLength(4);
    expect(screen.getByRole('option', { name: 'Multimedia' })).toHaveAttribute('aria-selected', 'false');
    expect(status()).toHaveTextContent('4 elementos seleccionados40 bytes');

    await user.keyboard('{Control>}a{/Control}');
    expect(screen.getAllByRole('option', { selected: true })).toHaveLength(8);

    await user.click(
      screen
        .getByText('8 elementos seleccionados')
        .closest('footer')!
        .previousElementSibling!.querySelector('.wfb-items')!,
    );
    expect(screen.queryAllByRole('option', { selected: true })).toHaveLength(0);
  });

  it('moves the selection with the arrow keys (Shift extends)', async () => {
    const { user } = await openEngineering();
    await user.click(screen.getByRole('option', { name: 'Documentación' }));
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('option', { name: 'Multimedia' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('option', { name: 'Documentación' })).toHaveAttribute('aria-selected', 'false');
    await user.keyboard('{Shift>}{ArrowDown}{ArrowDown}{/Shift}');
    expect(screen.getAllByRole('option', { selected: true })).toHaveLength(3);
    await user.keyboard('{End}');
    expect(
      screen.getAllByRole('option', { selected: true }).map((o) => o.getAttribute('aria-label')),
    ).toEqual(['notas.txt']);
  });

  it('sorts by clicking the column headers', async () => {
    const { user } = await openEngineering();
    expect(names()).toEqual([
      'Documentación',
      'Multimedia',
      'Proyectos',
      'Vacía',
      'backup.zip',
      'config.json',
      'diagrama.svg',
      'notas.txt',
    ]);
    await user.click(screen.getByRole('button', { name: 'Tamaño' }));
    expect(names().slice(4)).toEqual(['config.json', 'notas.txt', 'diagrama.svg', 'backup.zip']);
    expect(screen.getByRole('button', { name: /Tamaño/ })).toHaveAttribute('aria-sort', 'ascending');
    await user.click(screen.getByRole('button', { name: /Tamaño/ }));
    expect(names().slice(4)).toEqual(['backup.zip', 'diagrama.svg', 'notas.txt', 'config.json']);
    await user.click(screen.getByRole('button', { name: 'Nombre' }));
    await user.click(screen.getByRole('button', { name: /Nombre/ }));
    expect(names()[0]).toBe('Vacía');
  });

  it('switches views from the Ver menu', async () => {
    const { user } = await openEngineering();
    await user.click(screen.getByRole('button', { name: 'Ver' }));
    await user.click(screen.getByRole('menuitemradio', { name: 'Iconos grandes' }));
    expect(document.querySelector('.wfb-view-icons')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Nombre' })).toBeNull();
  });
});

describe('Explorer: clipboard and conflicts', () => {
  it('copy + paste creates the item in the destination', async () => {
    const { user } = await openEngineering();
    await user.click(screen.getByRole('option', { name: 'notas.txt' }));
    await user.keyboard('{Control>}c{/Control}');
    expect(useClipboard.getState()).toMatchObject({
      mode: 'copy',
      items: [{ share: 'engineering', path: '/notas.txt' }],
    });
    await user.dblClick(screen.getByRole('option', { name: 'Documentación' }));
    await option('Especificación.pdf');
    await user.keyboard('{Control>}v{/Control}');
    expect(await option('notas.txt')).toHaveAttribute('aria-selected', 'true');
    await user.click(screen.getByRole('button', { name: 'Atrás' }));
    expect(await option('notas.txt')).toBeInTheDocument();
  });

  it('cut + paste moves the item and clears the clipboard', async () => {
    const { user } = await openEngineering();
    await user.click(screen.getByRole('option', { name: 'config.json' }));
    await user.click(screen.getByRole('button', { name: 'Cortar' }));
    expect(screen.getByRole('option', { name: 'config.json' })).toHaveClass('is-cut');
    await user.dblClick(screen.getByRole('option', { name: 'Vacía' }));
    await screen.findByText('Esta carpeta está vacía.');
    await user.click(screen.getByRole('button', { name: 'Pegar' }));
    expect(await option('config.json')).toBeInTheDocument();
    expect(useClipboard.getState().items).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Atrás' }));
    await option('notas.txt');
    expect(screen.queryByRole('option', { name: 'config.json' })).toBeNull();
  });

  it('pastes across shares', async () => {
    const { user } = await openEngineering();
    await user.click(screen.getByRole('option', { name: 'notas.txt' }));
    await user.keyboard('{Control>}c{/Control}');
    await user.click(within(screen.getByRole('tree')).getByText('Mi carpeta'));
    await user.click(await option('tareas.md'));
    await user.keyboard('{Control>}v{/Control}');
    expect(await option('notas.txt')).toBeInTheDocument();
  });

  it('asks how to resolve conflicts and retries with "Conservar ambos"', async () => {
    const bodies: unknown[] = [];
    server.events.on('request:start', async ({ request }) => {
      if (request.url.endsWith('/api/files/copy')) bodies.push(await request.clone().json());
    });
    const { user } = await openEngineering();
    await user.click(screen.getByRole('option', { name: 'notas.txt' }));
    await user.keyboard('{Control>}c{/Control}');
    await user.dblClick(screen.getByRole('option', { name: 'Documentación' }));
    await option('Especificación.pdf');
    await user.keyboard('{Control>}v{/Control}');
    await option('notas.txt');
    await user.keyboard('{Control>}v{/Control}');

    const dialog = await screen.findByRole('dialog', { name: 'Reemplazar u omitir archivos' });
    expect(dialog).toHaveTextContent('El destino ya tiene un elemento llamado «notas.txt»');
    await user.click(within(dialog).getByRole('button', { name: /Conservar ambos/ }));
    expect(await option('notas (2).txt')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(bodies.map((b) => (b as { conflict: string }).conflict)).toEqual(['fail', 'fail', 'rename']);
    server.events.removeAllListeners();
  });

  it('copying next to the source keeps both without asking', async () => {
    const { user } = await openEngineering();
    await user.click(screen.getByRole('option', { name: 'notas.txt' }));
    await user.keyboard('{Control>}c{/Control}{Control>}v{/Control}');
    expect(await option('notas (2).txt')).toBeInTheDocument();
  });

  it('reports per-item failures in a toast', async () => {
    server.use(
      http.post('/api/files/move', () =>
        HttpResponse.json({
          mode: 'sync',
          results: [
            {
              source: { share: 'engineering', path: '/notas.txt' },
              status: 'failed',
              target: null,
              error: 'Bloqueado',
            },
          ],
        }),
      ),
    );
    const { user } = await openEngineering();
    await user.click(screen.getByRole('option', { name: 'notas.txt' }));
    await user.keyboard('{Control>}x{/Control}');
    await user.dblClick(screen.getByRole('option', { name: 'Vacía' }));
    await screen.findByText('Esta carpeta está vacía.');
    await user.keyboard('{Control>}v{/Control}');
    expect(await screen.findByText('No se pudo mover 1 elemento')).toBeInTheDocument();
    expect(screen.getByText('notas.txt: Bloqueado')).toBeInTheDocument();
    expect(useClipboard.getState().items).toHaveLength(1);
  });
});

describe('Explorer: rename, create, delete', () => {
  it('renames inline with F2, pre-selecting the name without extension', async () => {
    const { user } = await openEngineering();
    await user.click(screen.getByRole('option', { name: 'notas.txt' }));
    await user.keyboard('{F2}');
    const input = screen.getByRole<HTMLInputElement>('textbox', { name: 'Nuevo nombre' });
    expect(input).toHaveFocus();
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 5]);
    await user.keyboard('apuntes{Enter}');
    expect(await option('apuntes.txt')).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('option', { name: 'notas.txt' })).toBeNull();
  });

  it('cancels rename with Escape', async () => {
    const { user } = await openEngineering();
    await user.click(screen.getByRole('option', { name: 'notas.txt' }));
    await user.keyboard('{F2}otro{Escape}');
    expect(screen.queryByRole('textbox', { name: 'Nuevo nombre' })).toBeNull();
    expect(screen.getByRole('option', { name: 'notas.txt' })).toBeInTheDocument();
  });

  it('creates "Nueva carpeta" with Ctrl+Shift+N in rename mode, then "Nueva carpeta (2)"', async () => {
    const { user } = await openEngineering();
    await user.click(screen.getByRole('option', { name: 'notas.txt' }));
    await user.keyboard('{Control>}{Shift>}N{/Shift}{/Control}');
    const input = await screen.findByRole('textbox', { name: 'Nuevo nombre' });
    expect(input).toHaveValue('Nueva carpeta');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Nuevo nombre' })).toBeNull());
    await user.keyboard('{Control>}{Shift>}N{/Shift}{/Control}');
    expect(await screen.findByRole('textbox', { name: 'Nuevo nombre' })).toHaveValue('Nueva carpeta (2)');
    await user.keyboard('Informes{Enter}');
    expect(await option('Informes')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Nueva carpeta' })).toBeInTheDocument();
  });

  it('moves to the trash with Delete after confirmation', async () => {
    const { user } = await openEngineering();
    await user.click(screen.getByRole('option', { name: 'notas.txt' }));
    await user.keyboard('{Delete}');
    const dialog = screen.getByRole('dialog', { name: 'Mover a la papelera' });
    expect(dialog).toHaveTextContent('¿Está seguro de que desea mover «notas.txt» a la papelera?');
    await user.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    expect(screen.getByRole('option', { name: 'notas.txt' })).toBeInTheDocument();

    await user.keyboard('{Delete}');
    await user.click(screen.getByRole('button', { name: 'Mover a la papelera' }));
    await waitFor(() => expect(screen.queryByRole('option', { name: 'notas.txt' })).toBeNull());
  });

  it('deletes permanently with Shift+Delete', async () => {
    const bodies: unknown[] = [];
    server.events.on('request:start', async ({ request }) => {
      if (request.url.endsWith('/api/files/delete')) bodies.push(await request.clone().json());
    });
    const { user } = await openEngineering();
    await user.click(screen.getByRole('option', { name: 'backup.zip' }));
    await user.keyboard('{Shift>}{Delete}{/Shift}');
    const dialog = screen.getByRole('dialog', { name: 'Eliminar archivo' });
    await user.click(within(dialog).getByRole('button', { name: 'Eliminar' }));
    await waitFor(() => expect(screen.queryByRole('option', { name: 'backup.zip' })).toBeNull());
    expect(bodies).toEqual([{ items: [{ share: 'engineering', path: '/backup.zip' }], permanent: true }]);
    server.events.removeAllListeners();
  });
});

describe('Explorer: context menu', () => {
  it('offers item actions and runs them', async () => {
    const { user } = await openEngineering();
    await user.pointer({ keys: '[MouseRight]', target: screen.getByRole('option', { name: 'notas.txt' }) });
    const menu = screen.getByRole('menu', { name: 'Acciones del elemento' });
    for (const label of ['Abrir', 'Cortar', 'Copiar', 'Renombrar', 'Eliminar', 'Descargar', 'Propiedades']) {
      expect(within(menu).getByRole('menuitem', { name: new RegExp(`^${label}`) })).toBeInTheDocument();
    }
    await user.click(within(menu).getByRole('menuitem', { name: /^Copiar/ }));
    expect(screen.queryByRole('menu')).toBeNull();

    await user.pointer({ keys: '[MouseRight]', target: screen.getByRole('option', { name: 'Vacía' }) });
    await user.click(screen.getByRole('menuitem', { name: /^Pegar/ }));
    await user.dblClick(screen.getByRole('option', { name: 'Vacía' }));
    expect(await option('notas.txt')).toBeInTheDocument();
  });

  it('is keyboard accessible and closes with Escape', async () => {
    const { user } = await openEngineering();
    await user.click(screen.getByRole('option', { name: 'notas.txt' }));
    await user.keyboard('{Shift>}{F10}{/Shift}');
    const menu = screen.getByRole('menu');
    expect(menu).toHaveFocus();
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}');
    expect(menu.getAttribute('aria-activedescendant')).toBe(
      within(menu).getByRole('menuitem', { name: /^Renombrar/ }).id,
    );
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByRole('listbox')).toHaveFocus();
  });

  it('offers background actions: new folder through the submenu', async () => {
    const { user } = await openEngineering();
    await user.pointer({ keys: '[MouseRight]', target: document.querySelector('.wfb-items')! });
    const menu = screen.getByRole('menu', { name: 'Acciones de la carpeta' });
    for (const label of ['Ver', 'Ordenar por', 'Actualizar', 'Pegar', 'Nuevo', 'Subir archivos']) {
      expect(within(menu).getByRole('menuitem', { name: new RegExp(`^${label}`) })).toBeInTheDocument();
    }
    expect(within(menu).getByRole('menuitem', { name: /^Pegar/ })).toHaveAttribute('aria-disabled', 'true');
    await user.click(within(menu).getByRole('menuitem', { name: /^Nuevo/ }));
    await user.click(await screen.findByRole('menuitem', { name: /^Carpeta/ }));
    expect(await screen.findByRole('textbox', { name: 'Nuevo nombre' })).toHaveValue('Nueva carpeta');
  });

  it('closes on outside click', async () => {
    const { user } = await openEngineering();
    await user.pointer({ keys: '[MouseRight]', target: screen.getByRole('option', { name: 'notas.txt' }) });
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await user.click(screen.getByRole('contentinfo'));
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('Explorer: permissions, details pane, upload', () => {
  it('disables write and delete actions on a read-only share', async () => {
    const { user } = renderExplorer();
    await user.click(await option('LEEME.txt'));
    expect(screen.getByRole('button', { name: /Nuevo/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cortar' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Eliminar' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Renombrar' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Copiar' })).toBeEnabled();
    expect(status()).toHaveTextContent('Solo lectura');

    await user.keyboard('{F2}{Delete}');
    expect(screen.queryByRole('textbox', { name: 'Nuevo nombre' })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();

    await user.keyboard('{Control>}c{/Control}');
    expect(screen.getByRole('button', { name: 'Pegar' })).toBeDisabled();

    await user.pointer({ keys: '[MouseRight]', target: screen.getByRole('option', { name: 'LEEME.txt' }) });
    const menu = screen.getByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: /^Renombrar/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(within(menu).getByRole('menuitem', { name: /^Eliminar/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(within(menu).getByRole('menuitem', { name: /^Cortar/ })).toHaveAttribute('aria-disabled', 'true');
  });

  it('shows the details pane with properties and the preview slot', async () => {
    const renderPreview = vi.fn(() => <div>vista previa</div>);
    const { user } = await openEngineering({ renderPreview });
    await user.click(screen.getByRole('button', { name: 'Panel de detalles' }));
    const pane = screen.getByRole('complementary', { name: 'Panel de detalles' });
    expect(pane).toHaveTextContent('Ingeniería');
    await user.click(screen.getByRole('option', { name: 'notas.txt' }));
    expect(within(pane).getByText('vista previa')).toBeInTheDocument();
    expect(renderPreview).toHaveBeenCalledWith(expect.objectContaining({ name: 'notas.txt' }), 'engineering');
    expect(pane).toHaveTextContent('Documento de texto');
    expect(pane).toHaveTextContent('40 bytes');
  });

  it('uploads files picked from "Subir archivos"', async () => {
    // jsdom's FormData cannot be streamed through Node's fetch; the multipart handler is covered in handlers.test.ts.
    const queries: string[] = [];
    server.use(
      http.post('/api/files/upload', ({ request }) => {
        queries.push(new URL(request.url).search);
        db.shares.get('engineering')!.root.children.set('subido.txt', {
          type: 'file',
          name: 'subido.txt',
          modifiedAt: new Date().toISOString(),
          mime: 'text/plain',
          content: new Uint8Array(4),
        });
        return HttpResponse.json({ entries: [] }, { status: 201 });
      }),
    );
    const { user } = await openEngineering();
    await user.click(screen.getByRole('button', { name: /Nuevo/ }));
    expect(screen.getByRole('menuitem', { name: /Subir archivos/ })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    const file = new File(['hola'], 'subido.txt', { type: 'text/plain' });
    await act(async () => {
      await user.upload(screen.getByTestId('upload-input'), file);
    });
    expect(await option('subido.txt')).toBeInTheDocument();
    expect(queries).toEqual(['?share=engineering&path=%2F&conflict=fail']);
  });
});
