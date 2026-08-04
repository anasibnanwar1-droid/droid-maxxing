import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { StoreProvider } from './hooks/useStore';
import { initializeRendererDiagnostics } from './lib/rendererDiagnostics';
import App from './App';
import './index.css';

if (window.droidControl) void initializeRendererDiagnostics();

const root = document.getElementById('root');
if (!root) throw new Error('DROIDEX root element is missing.');

createRoot(root).render(
  <StrictMode>
    <StoreProvider>
      <App />
    </StoreProvider>
  </StrictMode>,
);
