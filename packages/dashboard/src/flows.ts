import type { InboxRecord } from "./types.js";

/**
 * Multi-page flows in the list: every loaded step of a flow (feedbacks
 * sharing a `flowId`) folds into one row, which expands to the steps in
 * order. Presentation only — `useSitepingInbox` keeps its flat `items`, and
 * each step stays an ordinary feedback with its own status.
 */

/** The loaded steps of one flow, in step order. */
export interface FlowGroup {
  flowId: string;
  title: string | null;
  steps: InboxRecord[];
}

/** A line of the list: a feedback (a step when `step` is set), or a flow's row. */
export type ListEntry =
  | { kind: "feedback"; record: InboxRecord; step?: number | undefined }
  | { kind: "flow"; group: FlowGroup; expanded: boolean };

/**
 * Id of a flow's row — the listbox option id and the `focusedId` it takes.
 * The `flow:` prefix keeps it apart from feedback ids.
 */
export function flowRowId(flowId: string): string {
  return `flow:${flowId}`;
}

/** The id `focusedId` holds for an entry. */
export function entryId(entry: ListEntry): string {
  return entry.kind === "flow" ? flowRowId(entry.group.flowId) : entry.record.id;
}

/**
 * The list's lines for `items`: a flow's row takes the place of its first
 * listed step (the newest, in the inbox's order), followed by every step
 * when it is in `expanded`; feedback outside a flow keeps its place.
 */
export function listEntries(items: readonly InboxRecord[], expanded: ReadonlySet<string>): ListEntry[] {
  const groups = new Map<string, FlowGroup>();
  for (const record of items) {
    if (!record.flowId) continue;
    const group = groups.get(record.flowId);
    if (group) group.steps.push(record);
    else groups.set(record.flowId, { flowId: record.flowId, title: record.flowTitle ?? null, steps: [record] });
  }
  for (const group of groups.values()) group.steps.sort((a, b) => (a.flowStep ?? 0) - (b.flowStep ?? 0));

  const entries: ListEntry[] = [];
  const placed = new Set<string>();
  for (const record of items) {
    const group = record.flowId ? groups.get(record.flowId) : undefined;
    if (!group) {
      entries.push({ kind: "feedback", record });
      continue;
    }
    // Placed once, at its first listed step.
    if (placed.has(group.flowId)) continue;
    placed.add(group.flowId);
    const isExpanded = expanded.has(group.flowId);
    entries.push({ kind: "flow", group, expanded: isExpanded });
    if (isExpanded) {
      for (const step of group.steps)
        entries.push({ kind: "feedback", record: step, step: step.flowStep ?? undefined });
    }
  }
  return entries;
}
