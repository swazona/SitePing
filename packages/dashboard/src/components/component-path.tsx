import type { ReactElement } from "react";
import { useRef, useState } from "react";
import { canCopy, copyOrSelect } from "../clipboard.js";
import { tWithParams } from "../i18n/index.js";
import { useInboxUi } from "./context.js";
import { CopyIcon } from "./icons.js";

/** Longer paths fold their middle behind "…": the root and the nearest components stay readable. */
const FOLD_OVER = 4;
/** Components kept at the end of a folded path, the annotated one last. */
const FOLD_TAIL = 2;

interface ComponentPathProps {
  /** Component names, root first — `componentPath(record.diagnostics)`. Non-empty. */
  names: readonly string[];
}

/**
 * The React component path as a breadcrumb — `App › Layout › CheckoutForm`.
 * A long one folds its middle behind a "…" button; each name ellipsizes on
 * its own (full name in its title) so the nearest component, last, stays
 * whole. The copy button (where the page may
 * write to the clipboard) puts the whole path there, as printed.
 */
export function ComponentPath({ names }: ComponentPathProps): ReactElement {
  const { t, notify } = useInboxUi();
  const [expanded, setExpanded] = useState(false);
  const listRef = useRef<HTMLOListElement | null>(null);
  const text = names.join(" › ");
  const folded = !expanded && names.length > FOLD_OVER;
  const shown: Array<{ name: string; index: number } | "fold"> = folded
    ? [
        { name: names[0] as string, index: 0 },
        "fold",
        ...names.slice(-FOLD_TAIL).map((name, i) => ({ name, index: names.length - FOLD_TAIL + i })),
      ]
    : names.map((name, index) => ({ name, index }));

  const copy = async (): Promise<void> => {
    if (await copyOrSelect(text, listRef.current)) notify(t("inbox.copied"));
  };

  const expand = (): void => {
    setExpanded(true);
    // The fold button unmounts: keep the focus in the path rather than on <body>.
    queueMicrotask(() => listRef.current?.focus());
  };

  return (
    <div className="spd-crumbs">
      <ol ref={listRef} className="spd-crumbs-list" aria-label={t("drawer.componentPath")} tabIndex={-1}>
        {shown.map((item, position) => (
          <li key={item === "fold" ? "fold" : item.index} className="spd-crumb">
            {position > 0 ? (
              <span className="spd-crumb-sep" aria-hidden="true">
                ›
              </span>
            ) : null}
            {item === "fold" ? (
              <button
                type="button"
                className="spd-crumb-fold"
                aria-label={tWithParams(t, "drawer.showFullPath", { count: names.length })}
                title={tWithParams(t, "drawer.showFullPath", { count: names.length })}
                onClick={expand}
              >
                …
              </button>
            ) : (
              <span className="spd-crumb-name" title={item.name}>
                {item.name}
              </span>
            )}
          </li>
        ))}
      </ol>
      {canCopy() ? (
        <button
          type="button"
          className="spd-icon-btn spd-crumbs-copy"
          aria-label={t("drawer.copyComponentPath")}
          title={t("drawer.copyComponentPath")}
          onClick={() => void copy()}
        >
          <CopyIcon />
        </button>
      ) : null}
    </div>
  );
}
