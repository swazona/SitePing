import { Z_INDEX_MAX } from "./constants.js";
import { el, focusRing, pressable, setText } from "./dom-utils.js";
import { addSurfaceKeydownListener, isolateFromHost, registerEscapeLayer } from "./host-isolation.js";
import { SYSTEM_FONT } from "./styles/theme.js";

/**
 * The DOM helpers the lazily loaded surfaces (screenshot editor, recording
 * indicator) build with, handed to them at call time. Imported statically,
 * these modules would be split out of the first-load bundle into shared
 * chunks of their own, each gzipped apart — the kit keeps them where they are.
 */
export const surfaceKit = {
  el,
  setText,
  focusRing,
  pressable,
  isolateFromHost,
  addSurfaceKeydownListener,
  registerEscapeLayer,
  zIndex: Z_INDEX_MAX,
  font: SYSTEM_FONT,
};

export type SurfaceKit = typeof surfaceKit;
