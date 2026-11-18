import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './styles.css';

async function bootstrap() {
  // Progressive enhancement polyfill for focusgroup tablist pattern (Modern Web Guidance)
  if (!Object.hasOwn(HTMLElement.prototype, 'focusGroup')) {
    try {
      const mod = await import('@microsoft/focusgroup-polyfill');
      if (typeof mod.polyfillBodyAndObserve === 'function') {
        mod.polyfillBodyAndObserve();
      } else if (typeof mod.polyfill === 'function') {
        mod.polyfill(document.body);
      }
    } catch {
      // Fallback: keyboard arrow navigation still handled smoothly if polyfill fails
    }
  }

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}

bootstrap();
