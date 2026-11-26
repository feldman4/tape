import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './ui/App.tsx';
import './ui/style.css';

const root = document.getElementById('app');
if (!root) throw new Error('App root not found');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
