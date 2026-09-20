import { mountWorkspace } from '../build/core/app/workspace.js';
const root = document.getElementById('root');
mountWorkspace(root).catch(error => {
  root.textContent = `The local workspace could not open: ${error.message}. Existing data was not cleared.`;
});
