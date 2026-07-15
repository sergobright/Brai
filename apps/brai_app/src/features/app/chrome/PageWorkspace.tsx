import type { ReactNode } from "react";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { cx } from "../appUtils";

/** Shared responsive geometry for page main content and its optional panel. */
export function PageWorkspace({
  className,
  fullBleed = false,
  main,
  mainClassName,
  mainScroll = true,
  persistentPanel,
  temporaryPanel,
  panelClassName,
  panelScroll = true,
}: {
  className?: string;
  fullBleed?: boolean;
  main: ReactNode;
  mainClassName?: string;
  mainScroll?: boolean;
  persistentPanel?: ReactNode;
  temporaryPanel?: ReactNode;
  panelClassName?: string;
  panelScroll?: boolean;
}) {
  const panel = temporaryPanel ?? persistentPanel;
  const split = panel != null;
  const mainRegionClassName = cx(
    "page-main h-full min-h-0 min-w-0",
    !split && !fullBleed && "mx-auto w-full max-w-3xl",
    fullBleed && "w-full max-w-none",
    mainClassName,
  );
  const panelRegionClassName = cx("page-panel h-full min-h-0 min-w-0 max-[860px]:hidden", panelClassName);

  return (
    <div
      className={cx(
        "page-workspace grid h-full min-h-0 min-w-0 overflow-hidden max-[860px]:block",
        split ? "has-panel grid-cols-2" : "grid-cols-1",
        className,
      )}
    >
      {mainScroll ? (
        <ScrollArea
          className={cx(mainRegionClassName, "[&>[data-slot=scroll-area-viewport]]:overscroll-contain")}
          contentInset={fullBleed ? "none" : "end"}
        >
          {main}
        </ScrollArea>
      ) : <div className={cx(mainRegionClassName, "overflow-hidden")}>{main}</div>}
      {split ? (
        panelScroll ? (
          <ScrollArea
            className={cx(panelRegionClassName, "[&>[data-slot=scroll-area-viewport]]:overscroll-contain")}
            data-nav-swipe-exclusion
          >
            {panel}
          </ScrollArea>
        ) : <aside className={cx(panelRegionClassName, "overflow-hidden")} data-nav-swipe-exclusion>{panel}</aside>
      ) : null}
    </div>
  );
}
