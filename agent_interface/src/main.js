import './styles/variables.css';
import './styles/base.css';
import './styles/layout.css';
import './styles/components.css';

import { createApp } from './app.js';

// Initialize app when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', createApp);
} else {
  createApp();
}
