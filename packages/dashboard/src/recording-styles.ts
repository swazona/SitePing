/**
 * Styles of the recording player, injected by the player itself so they
 * ship in its lazy chunk rather than in the inbox's first load. Scoped under
 * `.spd-root` like `INBOX_CSS`, whose custom properties they use. Minified
 * as CSS at build time (tsup.config.ts) — keep it a plain template literal.
 */
export const RECORDING_CSS = `
.spd-root .spd-player {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.spd-root .spd-player-video {
  display: block;
  width: 100%;
  aspect-ratio: 16 / 9;
  max-height: 60vh;
  object-fit: contain;
  border-radius: var(--spd-radius-sm);
  background: #000000;
}
.spd-root .spd-player-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.spd-root .spd-player-facts {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  font-size: 12px;
}
.spd-root .spd-player-facts > div {
  display: flex;
  gap: 6px;
}
.spd-root .spd-player-facts dt { color: var(--spd-text-2); }
.spd-root .spd-player-facts dd {
  color: var(--spd-text);
  font-variant-numeric: tabular-nums;
}
.spd-root .spd-player-download svg {
  width: 13px;
  height: 13px;
}
`;
