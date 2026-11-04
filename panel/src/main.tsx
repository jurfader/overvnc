import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import { App } from './App.tsx';
import { applyTheme, readTheme } from './components.tsx';
import './styles.css';

// ustaw motyw przed pierwszym renderem, żeby nie mignęło
applyTheme(readTheme());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
