import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface PageOptions {
  model: string;
  nonce: string;
}

const directory = path.dirname(fileURLToPath(import.meta.url));
const template = readFileSync(path.join(directory, 'page.html'), 'utf8');
const styles = readFileSync(path.join(directory, 'page.scss'), 'utf8');
const script = readFileSync(path.join(directory, 'page.js'), 'utf8');

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

export function renderChatPage({ model, nonce }: PageOptions): string {
  return template
    .replaceAll('__NONCE__', escapeHtml(nonce))
    .replace('/*__STYLES__*/', styles)
    .replace('/*__SCRIPT__*/', script)
    .replace('__MODEL__', escapeHtml(model));
}
