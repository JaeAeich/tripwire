// The draft being reviewed lives in sessionStorage, so a reload on the review page doesn't lose it.
import type { Draft } from "./types";

const KEY = "tw-draft";

export function putDraft(d: Draft) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(d));
  } catch {
    /* private mode: the review page will say there is no draft */
  }
}

export function takeDraft(): Draft | null {
  try {
    const s = sessionStorage.getItem(KEY);
    return s ? (JSON.parse(s) as Draft) : null;
  } catch {
    return null;
  }
}

export function clearDraft() {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
