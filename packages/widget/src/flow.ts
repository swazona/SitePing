import { CLIENT_ID_MAX_LENGTH, FLOW_TITLE_MAX_LENGTH, MAX_FLOW_STEPS } from "@siteping/core";

/** A multi-page flow in progress in this tab: each comment sent is its next step. */
export interface ActiveFlow {
  /** Shared by every step — a fresh client id, so the server's `flowId` rules hold. */
  id: string;
  /** What the reviewer called it, `null` when untitled. */
  title: string | null;
  /** The step the next comment records, from 1 to `MAX_FLOW_STEPS`. */
  step: number;
}

/** The active flow of one project and endpoint, kept for this tab. */
export interface FlowSession {
  read(): ActiveFlow | null;
  save(flow: ActiveFlow): void;
  clear(): void;
}

const FLOW_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/** Whether a stored value is a flow the server would accept steps of — anything else reads as no flow. */
function isActiveFlow(value: unknown): value is ActiveFlow {
  if (typeof value !== "object" || value === null) return false;
  const { id, title, step } = value as Record<string, unknown>;
  return (
    typeof id === "string" &&
    id.length <= CLIENT_ID_MAX_LENGTH &&
    FLOW_ID_PATTERN.test(id) &&
    (title === null || (typeof title === "string" && title.length <= FLOW_TITLE_MAX_LENGTH)) &&
    Number.isInteger(step) &&
    (step as number) >= 1 &&
    (step as number) <= MAX_FLOW_STEPS
  );
}

/**
 * The active flow, in sessionStorage: it survives reloads and navigation
 * within the tab — a flow walks across pages — and ends with the tab. One
 * per project and endpoint, like the "Mine" list. When storage is
 * unavailable the flow lasts as long as the page.
 */
export function flowSession(projectName: string, endpoint?: string): FlowSession {
  const key = `siteping_flow:${JSON.stringify([projectName, endpoint ?? null])}`;
  return {
    read() {
      try {
        const stored: unknown = JSON.parse(sessionStorage.getItem(key) ?? "null");
        return isActiveFlow(stored) ? stored : null;
      } catch {
        return null;
      }
    },
    save(flow) {
      try {
        sessionStorage.setItem(key, JSON.stringify(flow));
      } catch {
        // Storage unavailable or full: the flow ends with this page
      }
    },
    clear() {
      try {
        sessionStorage.removeItem(key);
      } catch {
        // Storage unavailable: nothing was kept
      }
    },
  };
}
