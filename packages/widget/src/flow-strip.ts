import type { ActiveFlow } from "./flow.js";
import type { registerEscapeLayer } from "./host-isolation.js";
import type { TFunction, tWithParams } from "./i18n/index.js";

/**
 * What the strip borrows from the widget, handed in rather than imported:
 * a value import of a module the panel imports too would split the shared
 * code into one more chunk, which every first load then downloads.
 */
export interface FlowStripDeps {
  t: TFunction;
  tWithParams: typeof tWithParams;
  registerEscapeLayer: typeof registerEscapeLayer;
  /** `FLOW_TITLE_MAX_LENGTH`. */
  maxTitleLength: number;
}

/** An element with a class — `hidden` with `display: none`, which `hidden` alone loses to the classes'. */
function node<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ""): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  return element;
}

function setHidden(element: HTMLElement, hidden: boolean): void {
  element.hidden = hidden;
  element.style.display = hidden ? "none" : "";
}

// Loaded with the strip, not with the widget: most visits never start a flow.
// Centred, so it needs no side in either writing direction; the buttons and
// input reuse the widget's own classes (`sp-input`, `sp-btn-*`).
const STRIP_CSS = /* css */ `
  .sp-flow {
    position: fixed;
    top: max(12px, env(safe-area-inset-top));
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 8px;
    max-width: calc(100vw - 32px);
    box-sizing: border-box;
    padding-block: 6px;
    padding-inline: 14px 6px;
    border-radius: 20px;
    background: var(--sp-material-thick);
    -webkit-backdrop-filter: var(--sp-material-blur);
    backdrop-filter: var(--sp-material-blur);
    color: var(--sp-text);
    font: 500 14px/1.35 var(--sp-font);
    box-shadow: inset 0 0.5px 0 var(--sp-edge), var(--sp-shadow-float);
  }
  .sp-flow-label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sp-flow-form {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0;
  }
  .sp-flow .sp-input {
    width: min(260px, 50vw);
    height: 32px;
  }
  .sp-flow .sp-btn-primary,
  .sp-flow .sp-btn-ghost {
    flex: none;
    height: 32px;
    padding: 0 14px;
    font-size: 14px;
  }
`;

/**
 * The strip of an active multi-page flow — "Flow: Sign-up · step 2" and a
 * Finish button — and the form that starts one. Escape inside it finishes
 * the flow, or cancels the form.
 */
export class FlowStrip {
  private readonly root: HTMLElement;
  private readonly label: HTMLElement;
  private readonly finishButton: HTMLButtonElement;
  private readonly form: HTMLFormElement;
  private readonly input: HTMLInputElement;
  private cancelAsk: (() => void) | null = null;
  private readonly unregisterEscape: () => void;

  constructor(
    shadowRoot: ShadowRoot,
    private readonly deps: FlowStripDeps,
    onFinish: () => void,
  ) {
    const { t } = deps;
    this.root = node("div", "sp-flow");
    this.root.setAttribute("role", "region");
    this.root.setAttribute("aria-label", t("flow.aria"));
    const style = node("style", "", STRIP_CSS);

    // Polite live region: each step the strip moves to is read out.
    this.label = node("span", "sp-flow-label");
    this.label.setAttribute("aria-live", "polite");
    this.finishButton = node("button", "sp-btn-primary", t("flow.finish"));
    this.finishButton.type = "button";
    this.finishButton.addEventListener("click", onFinish);

    this.form = node("form", "sp-flow-form");
    const inputLabel = node("label", "sp-flow-label", t("flow.titleLabel"));
    this.input = node("input", "sp-input");
    this.input.id = inputLabel.htmlFor = "sp-flow-title";
    this.input.maxLength = deps.maxTitleLength;
    this.input.placeholder = t("flow.titlePlaceholder");
    const start = node("button", "sp-btn-primary", t("flow.start"));
    start.type = "submit";
    const cancel = node("button", "sp-btn-ghost", t("popup.cancel"));
    cancel.type = "button";
    cancel.addEventListener("click", () => this.cancelAsk?.());
    this.form.append(inputLabel, this.input, start, cancel);

    this.root.append(style, this.label, this.finishButton, this.form);
    this.root.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      if (this.cancelAsk) this.cancelAsk();
      else onFinish();
    });
    this.unregisterEscape = deps.registerEscapeLayer(this.root, () => !this.root.hidden);
    setHidden(this.root, true);
    shadowRoot.appendChild(this.root);
  }

  /**
   * Ask for the flow's title. Resolves with the trimmed title (`""` for an
   * untitled flow), or `null` when the reviewer cancels.
   */
  ask(): Promise<string | null> {
    this.cancelAsk?.();
    this.input.value = "";
    this.setMode(true);
    setHidden(this.root, false);
    this.input.focus();
    return new Promise((resolve) => {
      const settle = (title: string | null) => {
        this.form.removeEventListener("submit", onSubmit);
        this.cancelAsk = null;
        if (title === null) setHidden(this.root, true);
        resolve(title);
      };
      const onSubmit = (e: SubmitEvent) => {
        e.preventDefault();
        settle(this.input.value.trim());
      };
      this.form.addEventListener("submit", onSubmit);
      this.cancelAsk = () => settle(null);
    });
  }

  /** Show the active flow, with the step its next comment records. */
  show(flow: ActiveFlow): void {
    const { t, tWithParams } = this.deps;
    const step = flow.step;
    const text = flow.title
      ? tWithParams(t, "flow.label", { title: flow.title, step })
      : tWithParams(t, "flow.labelUntitled", { step });
    this.label.textContent = text;
    this.label.title = text;
    this.setMode(false);
    setHidden(this.root, false);
  }

  /** Put focus on Finish — where Escape finishes the flow. */
  focus(): void {
    this.finishButton.focus();
  }

  hide(): void {
    this.cancelAsk?.();
    setHidden(this.root, true);
  }

  destroy(): void {
    this.cancelAsk?.();
    this.unregisterEscape();
    this.root.remove();
  }

  /** The title form, or the label and Finish. */
  private setMode(asking: boolean): void {
    setHidden(this.form, !asking);
    setHidden(this.label, asking);
    setHidden(this.finishButton, asking);
  }
}
