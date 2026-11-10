/**
 * React component path of a DOM element, read without depending on React.
 *
 * React DOM attaches its internal node (a "fiber") to every element it
 * renders under an expando key: `__reactFiber$<random>` since React 17,
 * `__reactInternalInstance$<random>` before. Each fiber links to its parent
 * through `return`, and a component's fiber carries the component itself as
 * `type`: walking up from the element's fiber and keeping the named
 * function/class types gives `["App", "Layout", "PricingCard"]`.
 *
 * These are React internals: every read is defensive, and any surprise
 * (another React version, a frozen object, a cycle) yields what was read so
 * far, or `null` — never a throw at submit time.
 */

/** Most component names kept: the ones nearest the element. */
export const MAX_COMPONENT_PATH = 30;
/** Longest name kept (the server caps it at 200). */
const MAX_NAME_LENGTH = 120;
/** DOM ancestors tried when the element itself was not rendered by React (e.g. inserted by a script). */
const MAX_DOM_HOPS = 20;
/** Fibers walked at most, whatever the tree's depth. */
const MAX_FIBERS = 5000;

const FIBER_KEY_PREFIXES = ["__reactFiber$", "__reactInternalInstance$"];

type Fiber = { type?: unknown; return?: unknown };

function fiberOf(element: Element): Fiber | null {
  for (const key of Object.keys(element)) {
    if (FIBER_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      const fiber = (element as unknown as Record<string, unknown>)[key];
      return typeof fiber === "object" && fiber !== null ? (fiber as Fiber) : null;
    }
  }
  return null;
}

/** A component's display name, or null for host elements, fragments, providers and anonymous functions. */
export function componentName(type: unknown): string | null {
  let name: unknown = null;
  if (typeof type === "function") {
    name = (type as { displayName?: unknown }).displayName || type.name;
  } else if (typeof type === "object" && type !== null) {
    // forwardRef ({ render }) and memo ({ type }) wrap the component.
    const wrapper = type as { displayName?: unknown; render?: unknown; type?: unknown };
    name = wrapper.displayName || componentName(wrapper.render) || componentName(wrapper.type);
  }
  return typeof name === "string" && name.length > 0 ? name.slice(0, MAX_NAME_LENGTH) : null;
}

/**
 * Component names from the root down to `element`, at most
 * {@link MAX_COMPONENT_PATH} (the nearest kept), or `null` when React did
 * not render it.
 */
export function reactComponentPath(element: Element | null): string[] | null {
  try {
    let fiber: Fiber | null = null;
    for (let node = element, hops = 0; node && !fiber && hops < MAX_DOM_HOPS; node = node.parentElement, hops++) {
      fiber = fiberOf(node);
    }
    if (!fiber) return null;
    const names: string[] = [];
    const seen = new Set<unknown>();
    for (let current: unknown = fiber; current && names.length < MAX_COMPONENT_PATH; ) {
      if (seen.has(current) || seen.size >= MAX_FIBERS || typeof current !== "object") break;
      seen.add(current);
      const name = componentName((current as Fiber).type);
      if (name) names.push(name);
      current = (current as Fiber).return;
    }
    return names.length > 0 ? names.reverse() : null;
  } catch {
    return null;
  }
}
