import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ErrorBoundary } from 'react-error-boundary';
import './styles/index.css';
import { detectCapabilities } from './core/platform/capabilities';
import { App } from './App';
import { AppErrorFallback } from './ui/AppErrorFallback';
import { CapabilityGate } from './ui/CapabilityGate';

// The capability gate runs before any store hydration or audio code — spec §2.1. When
// a hard requirement is missing, ONLY the blocking screen renders; nothing else loads.
const capabilities = detectCapabilities();

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('BangerBox: #root element missing from index.html');

createRoot(rootElement).render(
  <StrictMode>
    {capabilities.hardSupported ? (
      <ErrorBoundary FallbackComponent={AppErrorFallback}>
        <App capabilities={capabilities} />
      </ErrorBoundary>
    ) : (
      <CapabilityGate missing={capabilities.missingHard} />
    )}
  </StrictMode>,
);
