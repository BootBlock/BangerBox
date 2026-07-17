import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { ErrorBoundary } from 'react-error-boundary';
import './styles/index.css';
import { detectCapabilities } from './core/platform/capabilities';
import { acquireDatabaseTabLock } from './core/platform/multiTabGuard';
import { App } from './App';
import { AlreadyOpenScreen } from './ui/AlreadyOpenScreen';
import { AppErrorFallback } from './ui/AppErrorFallback';
import { CapabilityGate } from './ui/CapabilityGate';

// The capability gate runs before any store hydration or audio code — spec §2.1. When
// a hard requirement is missing, ONLY the blocking screen renders; nothing else loads.
const capabilities = detectCapabilities();

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('BangerBox: #root element missing from index.html');
const root = createRoot(rootElement);

function renderScreen(screen: ReactNode): void {
  root.render(<StrictMode>{screen}</StrictMode>);
}

async function bootstrap(): Promise<void> {
  if (!capabilities.hardSupported) {
    renderScreen(<CapabilityGate missing={capabilities.missingHard} />);
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
}

void bootstrap();
