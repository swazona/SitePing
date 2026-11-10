// @vitest-environment jsdom
import { act, createElement, forwardRef, memo } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { componentName, MAX_COMPONENT_PATH, reactComponentPath } from "../../src/dom/react-path.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Button() {
  return createElement("button", { id: "target", type: "button" }, "Buy");
}
const Card = memo(function PricingCard() {
  return createElement("section", null, createElement(Button));
});
const Wrapped = forwardRef<HTMLDivElement>(function Layout(_props, ref) {
  return createElement("div", { ref }, createElement(Card));
});
function App() {
  return createElement("main", null, createElement(Wrapped));
}
function Panel() {
  return createElement("div", { id: "panel" });
}

afterEach(() => {
  document.body.innerHTML = "";
});

function render(element: ReturnType<typeof createElement>): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(element));
  return container;
}

describe("reactComponentPath", () => {
  it("reads the component names from the root down to the element, on a real React tree", () => {
    const container = render(createElement(App));
    expect(reactComponentPath(container.querySelector("#target"))).toEqual(["App", "Layout", "PricingCard", "Button"]);
  });

  it("climbs the DOM to the nearest element React rendered", () => {
    const container = render(createElement(Panel));
    const injected = document.createElement("span");
    container.querySelector("#panel")?.appendChild(injected);

    expect(reactComponentPath(injected)).toEqual(["Panel"]);
  });

  it("is null on a page React does not render", () => {
    const plain = document.createElement("div");
    document.body.appendChild(plain);
    expect(reactComponentPath(plain)).toBeNull();
    expect(reactComponentPath(null)).toBeNull();
  });

  it("keeps the nearest names, at most MAX_COMPONENT_PATH", () => {
    const element = document.createElement("div");
    let fiber: Record<string, unknown> | null = null;
    for (let depth = 0; depth < 50; depth++) {
      fiber = { type: Object.assign(() => null, { displayName: `C${depth}` }), return: fiber };
    }
    // The innermost fiber was created last: C49 is the element's component.
    Object.assign(element, { __reactFiber$abc: fiber });

    const path = reactComponentPath(element);
    expect(path).toHaveLength(MAX_COMPONENT_PATH);
    expect(path?.at(-1)).toBe("C49");
    expect(path?.[0]).toBe("C20");
  });

  it("survives cycles and hostile internals", () => {
    const element = document.createElement("div");
    const a: Record<string, unknown> = { type: function A() {} };
    a.return = a;
    Object.assign(element, { __reactInternalInstance$x: a });
    expect(reactComponentPath(element)).toEqual(["A"]);

    const hostile = document.createElement("div");
    Object.assign(hostile, {
      __reactFiber$y: {
        get type() {
          throw new Error("boom");
        },
      },
    });
    expect(reactComponentPath(hostile)).toBeNull();
  });
});

describe("componentName", () => {
  it("skips host elements and anonymous functions", () => {
    expect(componentName("div")).toBeNull();
    expect(componentName(null)).toBeNull();
    expect(componentName(Symbol.for("react.fragment"))).toBeNull();
    expect(componentName(Object.assign(() => null, { displayName: "" }))).toBeNull();
    expect(componentName({ displayName: "Context.Provider" })).toBe("Context.Provider");
  });
});
