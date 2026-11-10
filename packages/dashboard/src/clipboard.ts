/** Whether this page can write to the clipboard at all — a copy control is offered only then. */
export function canCopy(): boolean {
  return typeof navigator !== "undefined" && Boolean(navigator.clipboard);
}

/**
 * Put `text` on the clipboard; true once it landed. When the write is
 * blocked (permission, insecure context), select the contents of `fallback`
 * instead, so a manual Ctrl+C works, and resolve false — the caller then
 * stays silent, since nothing reached the clipboard.
 */
export async function copyOrSelect(text: string, fallback: Node | null): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const selection = typeof window !== "undefined" ? window.getSelection() : null;
    if (fallback && selection) {
      const range = document.createRange();
      range.selectNodeContents(fallback);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    return false;
  }
}
