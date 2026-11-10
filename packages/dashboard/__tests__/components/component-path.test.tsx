// @vitest-environment jsdom

import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComponentPath } from "../../src/components/component-path.js";
import { renderWithUi } from "../render.js";

beforeEach(() => {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, "clipboard");
});

const crumbs = () => [...document.querySelectorAll(".spd-crumb-name")].map((el) => el.textContent);

describe("ComponentPath", () => {
  it("renders a short path whole, as a labelled list with decorative separators", () => {
    renderWithUi(<ComponentPath names={["App", "Layout", "CheckoutForm"]} />);
    const list = screen.getByRole("list", { name: "Component path" });
    expect(list.textContent).toBe("App›Layout›CheckoutForm");
    expect(crumbs()).toEqual(["App", "Layout", "CheckoutForm"]);
    for (const sep of document.querySelectorAll(".spd-crumb-sep")) expect(sep.getAttribute("aria-hidden")).toBe("true");
    expect(document.querySelector(".spd-crumb:last-child .spd-crumb-name")?.getAttribute("title")).toBe("CheckoutForm");
  });

  it("folds the middle of a long path and expands it on demand", () => {
    const names = ["App", "Providers", "Router", "Layout", "Page", "CheckoutForm"];
    renderWithUi(<ComponentPath names={names} />);
    expect(crumbs()).toEqual(["App", "Page", "CheckoutForm"]);
    const fold = screen.getByRole("button", { name: "Show all 6 components" });
    fireEvent.click(fold);
    expect(crumbs()).toEqual(names);
    expect(screen.queryByRole("button", { name: /Show all/ })).toBeNull();
  });

  it("copies the whole path, folded or not, and confirms", async () => {
    const names = ["App", "Providers", "Router", "Layout", "Page", "CheckoutForm"];
    const { value } = renderWithUi(<ComponentPath names={names} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy component path" }));
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        "App › Providers › Router › Layout › Page › CheckoutForm",
      ),
    );
    await waitFor(() => expect(value.notify).toHaveBeenCalledWith("Copied"));
  });

  it("selects the path and stays silent when the clipboard write fails", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("blocked"));
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const { value } = renderWithUi(<ComponentPath names={["App", "Form"]} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy component path" }));
    await waitFor(() => expect(window.getSelection()?.toString()).toContain("Form"));
    expect(value.notify).not.toHaveBeenCalled();
  });

  it("offers no copy button without a clipboard", () => {
    Reflect.deleteProperty(navigator, "clipboard");
    renderWithUi(<ComponentPath names={["App"]} />);
    expect(screen.queryByRole("button", { name: "Copy component path" })).toBeNull();
  });

  it("renders a hostile name as text", () => {
    renderWithUi(<ComponentPath names={["<img src=x onerror=alert(1)>"]} />);
    expect(document.querySelector("img")).toBeNull();
    expect(crumbs()).toEqual(["<img src=x onerror=alert(1)>"]);
  });
});
