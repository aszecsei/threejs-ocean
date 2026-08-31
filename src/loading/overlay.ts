// The "Generating Assets" screen.
//
// The markup and CSS live in index.html (so the scrim is painted before this
// module is even fetched); this file only drives them. The exit animation is
// CSS too -- adding `is-done` fades the panel, `is-slicing` splits the scrim
// along the anti-diagonal and slides the halves apart.

import * as flags from "../flags.js";

/** `?loading=0` skips the overlay, the warm-up and the transition entirely. */
export function loadingEnabled() { return flags.enabled("loading"); }
/** `?loading=debug` also prints the measured per-step cost table. */
export function loadingDebug() { return flags.is("loading", "debug"); }
/**
 * `?loading-hold=1` holds the finished overlay up until
 * `window.__demo.loading.finish()` is called, so the screen itself can be
 * screenshotted deterministically.
 */
export function loadingHold() { return flags.is("loading-hold", "1"); }

const PANEL_FADE_MS = 160;
const SLICE_MS = 560;
const LOG_LINES = 6;

export interface LoadingOverlay {
  /** `pct` is 0..1; `detail` is the step text under the bar. */
  setProgress(pct: number, detail: string): void;
  /** Appends a completed step and its measured cost to the log. */
  logStep(label: string, ms: number): void;
  /** Plays the exit transition and removes the node. Idempotent. */
  finish(): Promise<void>;
}

/** A no-op overlay, used for `?loading=0` and when the markup is absent. */
function nullOverlay(): LoadingOverlay {
  return {
    setProgress() {},
    logStep() {},
    finish() { return Promise.resolve(); },
  };
}

export function createLoadingOverlay(): LoadingOverlay {
  const root = document.getElementById("loading");
  const fill = document.getElementById("load-fill");
  const detailEl = document.getElementById("load-detail");
  const percentEl = document.getElementById("load-percent");
  const logEl = document.getElementById("load-log");
  if (!loadingEnabled() || !root || !fill || !detailEl || !percentEl || !logEl) {
    root?.remove();
    return nullOverlay();
  }

  let shownPercent = -1;
  let shownDetail = "";
  let finished: Promise<void> | null = null;

  return {
    setProgress(pct, detail) {
      // Bakes yield far more often than the display can change; skip the DOM
      // write unless something visible actually moved.
      const percent = Math.max(0, Math.min(100, Math.round(pct * 100)));
      if (percent !== shownPercent) {
        shownPercent = percent;
        fill.style.width = `${percent}%`;
        percentEl.textContent = `${percent}%`;
      }
      if (detail !== shownDetail) {
        shownDetail = detail;
        detailEl.textContent = detail;
      }
    },

    logStep(label, ms) {
      const row = document.createElement("div");
      row.append(label, Object.assign(document.createElement("span"), {
        textContent: `${Math.round(ms)} ms`,
      }));
      logEl.append(row);
      while (logEl.childElementCount > LOG_LINES) logEl.firstElementChild!.remove();
    },

    finish() {
      if (finished) return finished;
      finished = (async () => {
        // The panel straddles the diagonal cut, so it leaves first.
        root.classList.add("is-done");
        await wait(PANEL_FADE_MS);
        root.classList.add("is-slicing");
        await wait(SLICE_MS);
        root.remove();
      })();
      return finished;
    },
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
