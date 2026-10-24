import { useQueryClient } from '@tanstack/react-query';
import { Explorer } from './components/explorer';
import { PreviewPane, usePreviewModal } from './components/preview';
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
          onOpenFile={preview.open}
        />
        {preview.modal}
      </AuthGate>
    </AuthProvider>
  );
}
