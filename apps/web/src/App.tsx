import { useQueryClient } from '@tanstack/react-query';
import { Explorer } from './components/explorer';
import { AuthGate, AuthProvider, UserMenu } from './features/auth';

export function App() {
  const queryClient = useQueryClient();
  return (
    <AuthProvider onSignOut={() => queryClient.clear()}>
      <AuthGate>
        <Explorer headerRight={<UserMenu />} />
      </AuthGate>
    </AuthProvider>
  );
}
