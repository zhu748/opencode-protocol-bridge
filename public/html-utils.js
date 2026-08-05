const HTML_ESCAPES = Object.freeze({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
});

export function escapeHtml(value = '') {
  return String(value ?? '').replace(/[&<>"']/g, (character) => HTML_ESCAPES[character]);
}
