import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

// Inter Variable, self-hosted. NOT Google Fonts: the §16.2 CSP forbids external
// origins, and one variable file covers every weight the design uses.
import '@fontsource-variable/inter';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Installable PWA (§10.10). The worker caches the app shell only — never any
// financial data — so a stale balance can never be shown.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js');
  });
}
