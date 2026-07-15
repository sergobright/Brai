import { getBraiLocalStorageItem, setBraiLocalStorageItem } from "@/shared/storage/localStorageKeys";

export const ACTION_DELETE_COLLAPSE_MS = 180;
export const ACTION_DELETE_REVEAL_WIDTH = 54;
export const ACTION_ROW_SERVICE_SELECTOR = "[data-action-row-service], [data-action-row-control], [data-action-drag-handle], button, input, textarea, select, a, [role='button'], [role='slider']";
const ACTIVITY_MD_PREVIEW_STORAGE_KEY = "brai_activity_md_preview";

export function loadActivityMarkdownPreviewMode(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return getBraiLocalStorageItem(ACTIVITY_MD_PREVIEW_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function saveActivityMarkdownPreviewMode(enabled: boolean) {
  if (typeof window === "undefined") return;
  try {
    setBraiLocalStorageItem(ACTIVITY_MD_PREVIEW_STORAGE_KEY, enabled ? "true" : "false");
  } catch {
    // localStorage can be unavailable in constrained WebViews.
  }
}
