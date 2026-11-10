/**
 * Styles of the export dialog, injected by the dialog itself so they ship
 * in its lazy chunk rather than in the inbox's first load. Scoped under
 * `.spd-root` like `INBOX_CSS`, whose custom properties they use. Minified
 * as CSS at build time (tsup.config.ts) — keep it a plain template literal.
 */
export const EXPORT_CSS = `
.spd-export {
  position: absolute;
  inset: 0;
  z-index: 7;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: var(--spd-dim);
}
.spd-export-card {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 860px;
  max-height: 100%;
  background: var(--spd-surface);
  border: 1px solid var(--spd-border-strong);
  border-radius: var(--spd-radius);
  color: var(--spd-text);
}
.spd-export-head,
.spd-export-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
}
.spd-export-head { border-bottom: 1px solid var(--spd-border); }
.spd-export-foot { justify-content: flex-end; border-top: 1px solid var(--spd-border); }
.spd-export-title { flex: 1 1 auto; margin: 0; font-size: 13px; font-weight: 600; }
.spd-export-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
  padding: 12px 14px;
  overflow-y: auto;
}
.spd-export-options { display: flex; flex-wrap: wrap; gap: 12px 20px; }
.spd-export-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 140px;
  margin: 0;
  padding: 0;
  border: 0;
}
.spd-export-group legend { padding: 0; margin-bottom: 4px; }
.spd-export-picks { flex: 1 1 100%; max-height: 160px; overflow-y: auto; }
.spd-export-check {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--spd-text-2);
  cursor: pointer;
}
.spd-export-check input { margin: 0; accent-color: var(--spd-accent); }
.spd-export-pick { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
.spd-export-preview {
  width: 100%;
  min-height: 220px;
  flex: 1 1 auto;
  box-sizing: border-box;
  padding: 10px;
  font: 11.5px/1.5 var(--spd-mono);
  color: var(--spd-text);
  background: var(--spd-bg);
  border: 1px solid var(--spd-border);
  border-radius: var(--spd-radius-sm);
  resize: vertical;
  white-space: pre;
}
@container spd (min-width: 720px) {
  .spd-export-body { flex-direction: row; }
  .spd-export-options { flex-direction: column; flex: 0 0 220px; flex-wrap: nowrap; }
  .spd-export-picks { flex: 0 0 auto; }
}
`;
