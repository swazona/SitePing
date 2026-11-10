// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FlowStrip } from "../../src/flow-strip.js";
import { registerEscapeLayer } from "../../src/host-isolation.js";
import { createT, tWithParams } from "../../src/i18n/index.js";
import { createShadowRoot } from "../helpers.js";

const t = createT("en");

describe("FlowStrip", () => {
  let shadow: ShadowRoot;
  let onFinish: ReturnType<typeof vi.fn<() => void>>;
  let strip: FlowStrip;

  const root = () => shadow.querySelector<HTMLElement>(".sp-flow")!;
  const input = () => shadow.querySelector<HTMLInputElement>(".sp-flow input")!;
  const button = (text: string) =>
    Array.from(shadow.querySelectorAll<HTMLButtonElement>(".sp-flow button")).find((b) => b.textContent === text)!;
  const press = (key: string, target: Element = root()) =>
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));

  beforeEach(() => {
    shadow = createShadowRoot();
    onFinish = vi.fn<() => void>();
    strip = new FlowStrip(shadow, { t, tWithParams, registerEscapeLayer, maxTitleLength: 200 }, onFinish);
  });

  afterEach(() => {
    strip.destroy();
    shadow.host.remove();
  });

  it("starts hidden, as a labelled region", () => {
    expect(root().hidden).toBe(true);
    expect(root().getAttribute("role")).toBe("region");
    expect(root().getAttribute("aria-label")).toBe(t("flow.aria"));
  });

  it("asks for a title in a labelled field, focused, and resolves with it trimmed", async () => {
    const asked = strip.ask();
    expect(root().hidden).toBe(false);
    expect(shadow.activeElement).toBe(input());
    expect(shadow.querySelector(`label[for="${input().id}"]`)?.textContent).toBe(t("flow.titleLabel"));
    expect(input().maxLength).toBe(200);

    input().value = "  Sign-up  ";
    button(t("flow.start")).click();

    await expect(asked).resolves.toBe("Sign-up");
  });

  it("resolves an empty title for an untitled flow", async () => {
    const asked = strip.ask();
    button(t("flow.start")).click();
    await expect(asked).resolves.toBe("");
  });

  it.each([
    ["Cancel", () => button(t("popup.cancel")).click()],
    ["Escape", () => press("Escape", input())],
  ])("resolves null and hides on %s, without finishing anything", async (_label, cancel) => {
    const asked = strip.ask();
    cancel();
    await expect(asked).resolves.toBeNull();
    expect(root().hidden).toBe(true);
    expect(onFinish).not.toHaveBeenCalled();
  });

  it("shows the flow's title and the step its next comment records, with Finish", () => {
    strip.show({ id: "f", title: "Sign-up", step: 2 });
    expect(root().hidden).toBe(false);
    const label = shadow.querySelector(".sp-flow > .sp-flow-label")!;
    expect(label.textContent).toBe("Flow: Sign-up · step 2");
    expect(label.getAttribute("aria-live")).toBe("polite");
    expect(input().closest("form")!.hidden).toBe(true);

    strip.show({ id: "f", title: null, step: 3 });
    expect(label.textContent).toBe("Flow · step 3");

    button(t("flow.finish")).click();
    expect(onFinish).toHaveBeenCalledOnce();
  });

  it("finishes on Escape when the strip is focused, and keeps the key from the page", () => {
    strip.show({ id: "f", title: null, step: 1 });
    strip.focus();
    expect(shadow.activeElement).toBe(button(t("flow.finish")));
    const pageListener = vi.fn();
    document.addEventListener("keydown", pageListener);

    press("Escape", button(t("flow.finish")));

    document.removeEventListener("keydown", pageListener);
    expect(onFinish).toHaveBeenCalledOnce();
    expect(pageListener).not.toHaveBeenCalled();
  });

  it("hides, and is removed on destroy", () => {
    strip.show({ id: "f", title: null, step: 1 });
    strip.hide();
    expect(root().hidden).toBe(true);
    strip.destroy();
    expect(shadow.querySelector(".sp-flow")).toBeNull();
  });
});
