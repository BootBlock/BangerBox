import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { ErrorBoundary } from 'react-error-boundary';
import './styles/index.css';
import { detectCapabilities } from './core/platform/capabilities';
import { acquireDatabaseTabLock } from './core/platform/multiTabGuard';
import { startProjectSession } from './core/project';
import { useUIStore } from './store';
import { App } from './App';
import { AlreadyOpenScreen } from './ui/AlreadyOpenScreen';
import { AppErrorFallback } from './ui/AppErrorFallback';
import { CapabilityGate } from './ui/CapabilityGate';

// The capability gate runs before any store hydration or audio code — spec §2.1. When
// a hard requirement is missing, ONLY the blocking screen renders; nothing else loads.
const capabilities = detectCapabilities();
// Freeze the report into the UI store so every consumer reads one source (spec §2.1).
useUIStore.getState().setCapabilities(capabilities);

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('BangerBox: #root element missing from index.html');
const root = createRoot(rootElement);

function renderScreen(screen: ReactNode): void {
  root.render(<StrictMode>{screen}</StrictMode>);
}

async function bootstrap(): Promise<void> {
  if (!capabilities.hardSupported) {
    renderScreen(<CapabilityGate report={capabilities} />);
    return;
  }

  // Multi-tab guard before anything touches the database — the SQLite OPFS lock
  // makes this mandatory, not cosmetic (spec §8.1, §9.7).
  const tabLock = await acquireDatabaseTabLock();
  if (!tabLock.acquired) {
    renderScreen(<AlreadyOpenScreen whenReleased={tabLock.whenReleased} />);
    return;
  }

  renderScreen(
    <ErrorBoundary FallbackComponent={AppErrorFallback}>
      <App capabilities={capabilities} />
    </ErrorBoundary>,
  );

  // Boot the database, open/create the active project, hydrate the stores and register
  // the sync subscribers (spec §4.4). A boot failure means autosave was never wired, so
  // the shell would stay fully editable while persisting nothing and reporting "All
  // changes saved" — replace it with Safe Mode instead (spec §4.4, §8.1). The error
  // boundary above cannot catch this: the failure lands outside React's render path.
  void startProjectSession().catch((error: unknown) => {
    renderScreen(
      <AppErrorFallback
        error={error}
        resetErrorBoundary={() => {
          window.location.reload();
        }}
      />,
    );
  });
}

void bootstrap();
