import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import * as Sentry from '@sentry/electron/renderer';
import { StoreProvider } from './hooks/useStore';
import App from './App';
import './index.css';

if (window.droidControl) {
  Sentry.init({ sendDefaultPii: false, maxBreadcrumbs: 0, tracesSampleRate: 0 });
}

const root = document.getElementById('root');
if (!root) throw new Error('DROIDEX root element is missing.');

createRoot(root).render(
  <StrictMode>
    <StoreProvider>
      <App />
    </StoreProvider>
  </StrictMode>,
);
