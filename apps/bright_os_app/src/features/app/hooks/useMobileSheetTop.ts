"use client";

import { useLayoutEffect, useState } from "react";

/**
 * Returns the shared top edge for mobile bottom sheets under the current screen header.
 */
export function useMobileSheetTop() {
  const [sheetTop, setSheetTop] = useState<number | null>(null);

  useLayoutEffect(() => {
    function updateSheetTop() {
      const topbar = document.querySelector<HTMLElement>(".section-page-current .topbar");
      const nextTop = Math.ceil(topbar?.getBoundingClientRect().bottom ?? 0);
      setSheetTop((currentTop) => (currentTop === nextTop ? currentTop : nextTop));
    }

    updateSheetTop();
    const topbar = document.querySelector<HTMLElement>(".section-page-current .topbar");
    const observer = topbar && "ResizeObserver" in window ? new ResizeObserver(updateSheetTop) : null;
    if (topbar) observer?.observe(topbar);
    window.addEventListener("resize", updateSheetTop);
    window.visualViewport?.addEventListener("resize", updateSheetTop);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", updateSheetTop);
      window.visualViewport?.removeEventListener("resize", updateSheetTop);
    };
  }, []);

  return sheetTop ?? "var(--mobile-top-padding)";
}
