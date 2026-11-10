import { describe, expect, it } from "vitest";
import { entryId, flowRowId, listEntries } from "../../src/flows.js";
import { makeRecord } from "../helpers.js";

const step = (id: string, flowStep: number, flowId = "flow-a") =>
  makeRecord({ id, flowId, flowStep, flowTitle: flowId === "flow-a" ? "Sign-up" : null });

describe("listEntries", () => {
  // Newest first, as the inbox lists them: step 3 was sent last.
  const items = [
    makeRecord({ id: "lone-new" }),
    step("s3", 3),
    step("s1", 1),
    makeRecord({ id: "lone-old" }),
    step("s2", 2),
  ];

  it("folds a flow's steps into one row, where its newest step was", () => {
    const entries = listEntries(items, new Set());
    expect(entries.map(entryId)).toEqual(["lone-new", flowRowId("flow-a"), "lone-old"]);
    const flow = entries[1];
    expect(flow?.kind === "flow" && flow.group).toMatchObject({ flowId: "flow-a", title: "Sign-up" });
    expect(flow?.kind === "flow" && flow.group.steps.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
    expect(flow?.kind === "flow" && flow.expanded).toBe(false);
  });

  it("lists an expanded flow's steps right after its row, in step order", () => {
    const entries = listEntries(items, new Set(["flow-a"]));
    expect(entries.map(entryId)).toEqual(["lone-new", flowRowId("flow-a"), "s1", "s2", "s3", "lone-old"]);
    expect(entries.slice(2, 5).map((entry) => entry.kind === "feedback" && entry.step)).toEqual([1, 2, 3]);
  });

  it("keeps flows apart, untitled ones included, and leaves feedback outside flows as it was", () => {
    const entries = listEntries([step("b1", 1, "flow-b"), ...items], new Set());
    expect(entries.map(entryId)).toEqual([flowRowId("flow-b"), "lone-new", flowRowId("flow-a"), "lone-old"]);
    expect(entries[0]?.kind === "flow" && entries[0].group.title).toBeNull();
    expect(listEntries([makeRecord({ id: "x" })], new Set()).map(entryId)).toEqual(["x"]);
  });
});
