import { useQueryClient } from '@tanstack/react-query';
import { Explorer } from './components/explorer';
import { PreviewPane, Thumbnail, usePreviewModal } from './components/preview';
import { AuthGate, AuthProvider, UserMenu } from './features/auth';

export function App() {
  const queryClient = useQueryClient();
  const preview = usePreviewModal();
  return (
    <AuthProvider onSignOut={() => queryClient.clear()}>
      <AuthGate>
        <Explorer
          headerRight={<UserMenu />}
          renderPreview={(entry, share) => <PreviewPane entry={entry} share={share} />}
          renderThumbnail={(entry, share, fallback) => (
            <Thumbnail
              share={share}
              path={entry.path}
              size="medium"
              version={entry.modifiedAt}
              fallback={fallback}
            />
          )}
          onOpenFile={preview.open}
        />
        {preview.modal}
      </AuthGate>
    </AuthProvider>
  );
}
