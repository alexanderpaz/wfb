import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { FileEntry } from '@wfb/contracts';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import type { ReactNode } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../App';
import { resetMockDb } from '../../mocks/db';
import { server } from '../../mocks/server';
import { useExplorerPrefs } from '../../stores/explorerPrefs';
import { PreviewModal, PreviewPane, Thumbnail } from './index';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => {
  resetMockDb();
  localStorage.clear();
  useExplorerPrefs.getState().reset();
  window.history.replaceState(null, '', '/');
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function wrap(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const entry = (path: string, over: Partial<FileEntry> = {}): FileEntry => ({
  name: path.slice(path.lastIndexOf('/') + 1),
  path,
  type: 'file',
  size: 10,
  modifiedAt: '2026-10-01T10:00:00.000Z',
  mime: 'text/plain',
  previewable: true,
  ...over,
});

const info = (body: object) => http.get('*/api/preview/info', () => HttpResponse.json(body));

describe('PreviewPane', () => {
  it('shows highlighted code from the content endpoint', async () => {
    const { container } = wrap(
      <PreviewPane entry={entry('/Proyectos/Alfa/src/index.ts')} share="engineering" />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Cargando vista previa…');
    const code = await screen.findByLabelText('Contenido del archivo');
    expect(code).toHaveTextContent("export const hello = 'mundo';");
    await waitFor(() => expect(container.querySelector('.hljs-keyword')).toHaveTextContent('export'));
    expect(container.querySelector('code')).toHaveAttribute('data-language', 'typescript');
    expect(screen.queryByText('Vista previa truncada (1 MB)')).not.toBeInTheDocument();
  });

  it('notes truncated text and reports binary content', async () => {
    server.use(
      info({ kind: 'text', mime: 'text/plain', contentUrl: '/api/preview/content?x=1', language: null }),
      http.get(
        '*/api/preview/content',
        () => new HttpResponse('a'.repeat(50), { headers: { 'x-preview-truncated': 'true' } }),
      ),
    );
    const { unmount } = wrap(<PreviewPane entry={entry('/big.log')} share="engineering" />);
    expect(await screen.findByText('Vista previa truncada (1 MB)')).toBeInTheDocument();
    unmount();

    server.use(
      http.get('*/api/preview/content', () =>
        HttpResponse.json({ error: { code: 'BAD_REQUEST', message: 'Binary file' } }, { status: 415 }),
      ),
    );
    wrap(<PreviewPane entry={entry('/bin.log')} share="engineering" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('contiene datos binarios');
  });

  it('shows image thumbnails, falling back to the content and then to the icon', async () => {
    const e = entry('/Multimedia/foto-equipo.jpg', { mime: 'image/jpeg' });
    wrap(<PreviewPane entry={e} share="engineering" />);
    const img = await screen.findByRole('img', { name: 'foto-equipo.jpg' });
    const v = `v=${Date.parse(e.modifiedAt)}-10`;
    expect(img.getAttribute('src')).toBe(
      `/api/preview/thumbnail?share=engineering&path=%2FMultimedia%2Ffoto-equipo.jpg&size=medium&${v}`,
    );
    fireEvent.error(img);
    const second = screen.getByRole('img', { name: 'foto-equipo.jpg' });
    expect(second.getAttribute('src')).toMatch(/^\/api\/preview\/content\?.*&v=/);
    fireEvent.error(second);
    expect(screen.getByText('No hay vista previa disponible')).toBeInTheDocument();
  });

  it('embeds pdfs and media players', async () => {
    const { unmount } = wrap(
      <PreviewPane
        entry={entry('/Documentación/Especificación.pdf', { mime: 'application/pdf' })}
        share="engineering"
      />,
    );
    const frame = await screen.findByTitle('Vista previa de Especificación.pdf');
    expect(frame.tagName).toBe('IFRAME');
    expect(frame.getAttribute('src')).toMatch(/^\/api\/preview\/content\?.*#toolbar=0/);
    unmount();

    const { container, unmount: unmount2 } = wrap(
      <PreviewPane entry={entry('/Multimedia/demo.mp4', { mime: 'video/mp4' })} share="engineering" />,
    );
    await waitFor(() => expect(container.querySelector('video')).toHaveAttribute('controls'));
    fireEvent.error(container.querySelector('video')!);
    expect(screen.getByRole('alert')).toHaveTextContent('El navegador no puede reproducir este archivo.');
    unmount2();

    const { container: c3 } = wrap(
      <PreviewPane entry={entry('/Multimedia/podcast.mp3', { mime: 'audio/mpeg' })} share="engineering" />,
    );
    await waitFor(() => expect(c3.querySelector('audio')?.getAttribute('src')).toMatch(/podcast\.mp3/));
  });

  it('does not query non-previewable files and handles info errors', async () => {
    const calls = vi.fn();
    server.events.on('request:start', calls);
    const { unmount } = wrap(
      <PreviewPane
        entry={entry('/backup.zip', { previewable: false, mime: 'application/zip' })}
        share="engineering"
      />,
    );
    expect(screen.getByText('No hay vista previa disponible')).toBeInTheDocument();
    expect(calls).not.toHaveBeenCalled();
    server.events.removeAllListeners();
    unmount();

    wrap(<PreviewPane entry={entry('/missing.txt')} share="engineering" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo cargar la vista previa.');
  });
});

describe('Thumbnail', () => {
  it('renders a lazy image and the fallback on error', () => {
    render(<Thumbnail share="s" path="/a b.png" size="large" fallback={<span>icono</span>} version="1" />);
    const img = screen.getByRole('presentation');
    expect(img).toHaveAttribute('loading', 'lazy');
    expect(img).toHaveAttribute('src', '/api/preview/thumbnail?share=s&path=%2Fa+b.png&size=large&v=1');
    fireEvent.error(img);
    expect(screen.getByText('icono')).toBeInTheDocument();
  });
});

describe('PreviewModal', () => {
  const files = ['/notas.txt', '/config.json', '/diagrama.svg'].map((p) => entry(p));

  it('has a toolbar, closes with Esc and navigates with the arrows', async () => {
    const onClose = vi.fn();
    const onNavigate = vi.fn();
    const user = userEvent.setup();
    wrap(
      <PreviewModal
        entry={files[1]!}
        share="engineering"
        siblings={files}
        onNavigate={onNavigate}
        onClose={onClose}
      />,
    );
    const dialog = screen.getByRole('dialog', { name: 'Vista previa: config.json' });
    expect(dialog).toHaveFocus();
    expect(dialog).toHaveTextContent('2 de 3');
    expect(within(dialog).getByRole('link', { name: 'Descargar' })).toHaveAttribute(
      'href',
      '/api/files/download?share=engineering&path=%2Fconfig.json',
    );
    await waitFor(() =>
      expect(
        within(dialog).getByRole('link', { name: 'Abrir en pestaña nueva' }).getAttribute('href'),
      ).toMatch(/^\/api\/preview\/content\?share=engineering&path=%2Fconfig.json&v=/),
    );
    expect(within(dialog).getByRole('link', { name: 'Abrir en pestaña nueva' })).toHaveAttribute(
      'target',
      '_blank',
    );
    expect(await within(dialog).findByLabelText('Contenido del archivo')).toHaveTextContent('"debug": true');

    await user.keyboard('{ArrowRight}');
    expect(onNavigate).toHaveBeenLastCalledWith(files[2]);
    await user.keyboard('{ArrowLeft}');
    expect(onNavigate).toHaveBeenLastCalledWith(files[0]);
    await user.click(within(dialog).getByRole('button', { name: 'Siguiente' }));
    expect(onNavigate).toHaveBeenCalledTimes(3);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('works without siblings', async () => {
    const onClose = vi.fn();
    wrap(<PreviewModal entry={files[0]!} share="engineering" onClose={onClose} />);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByRole('button', { name: 'Anterior' })).not.toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cerrar' }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe('App wiring', () => {
  it('previews in the details pane and opens the modal with sibling navigation', async () => {
    window.history.replaceState(null, '', '/?share=engineering&path=/');
    const user = userEvent.setup();
    wrap(<App />);
    const notas = await screen.findByRole('option', { name: 'notas.txt' });
    await user.click(screen.getByRole('button', { name: 'Panel de detalles' }));
    await user.click(notas);
    const pane = screen.getByRole('complementary', { name: 'Panel de detalles' });
    expect(await within(pane).findByLabelText('Contenido del archivo')).toHaveTextContent(
      'Reunión del lunes',
    );

    await user.dblClick(notas);
    const dialog = await screen.findByRole('dialog', { name: 'Vista previa: notas.txt' });
    // Previewable files of the folder in name order: config.json, diagrama.svg, notas.txt.
    expect(dialog).toHaveTextContent('3 de 3');
    await user.keyboard('{ArrowLeft}');
    expect(await screen.findByRole('dialog', { name: 'Vista previa: diagrama.svg' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('downloads non-previewable files instead of opening the modal', async () => {
    window.history.replaceState(null, '', '/?share=engineering&path=/');
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const user = userEvent.setup();
    wrap(<App />);
    await user.dblClick(await screen.findByRole('option', { name: 'backup.zip' }));
    expect(click).toHaveBeenCalled();
    expect((click.mock.contexts[0] as HTMLAnchorElement).getAttribute('href')).toBe(
      '/api/files/download?share=engineering&path=%2Fbackup.zip',
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    click.mockRestore();
  });
});
