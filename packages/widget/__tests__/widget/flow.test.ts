// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { flowSession } from "../../src/flow.js";

describe("flowSession", () => {
  afterEach(() => {
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it("keeps the active flow in sessionStorage, as a reload would read it back", () => {
    flowSession("site", "/api/siteping").save({ id: "flow-1", title: "Sign-up", step: 2 });

    expect(flowSession("site", "/api/siteping").read()).toEqual({ id: "flow-1", title: "Sign-up", step: 2 });
  });

  it("keeps one flow per project and endpoint, store mode included", () => {
    flowSession("site", "/api/siteping").save({ id: "http", title: null, step: 1 });
    flowSession("site").save({ id: "store", title: null, step: 1 });

    expect(flowSession("other", "/api/siteping").read()).toBeNull();
    expect(flowSession("site", "/api/v2").read()).toBeNull();
    expect(flowSession("site").read()?.id).toBe("store");
    expect(flowSession("site", "/api/siteping").read()?.id).toBe("http");
  });

  it("forgets the flow on clear", () => {
    const flows = flowSession("site");
    flows.save({ id: "flow-1", title: null, step: 3 });
    flows.clear();

    expect(flows.read()).toBeNull();
  });

  it.each([
    ["not JSON", "{"],
    ["an id outside the clientId alphabet", JSON.stringify({ id: "../x", title: null, step: 1 })],
    ["a step past the cap", JSON.stringify({ id: "f", title: null, step: 101 })],
    ["a step that is not an integer", JSON.stringify({ id: "f", title: null, step: 1.5 })],
    ["a title past the cap", JSON.stringify({ id: "f", title: "t".repeat(201), step: 1 })],
    ["no title key", JSON.stringify({ id: "f", step: 1 })],
  ])("reads %s as no flow", (_label, raw) => {
    sessionStorage.setItem(`siteping_flow:${JSON.stringify(["site", null])}`, raw);

    expect(flowSession("site").read()).toBeNull();
  });

  it("works without storage: reads no flow, and never throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    const flows = flowSession("site");

    expect(() => flows.save({ id: "flow-1", title: null, step: 1 })).not.toThrow();
    expect(flows.read()).toBeNull();
    expect(() => flows.clear()).not.toThrow();
  });
});
