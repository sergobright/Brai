"use client";

import { Card } from "@/shared/ui/card";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { cx } from "../../appUtils";

export function ActionsInfoPanel({ label = "Информация о действиях", mobile = false }: { label?: string; mobile?: boolean }) {
  return (
    <aside
      className={cx(
        "actions-info-panel grid min-w-0 gap-3",
        mobile
          ? "py-1 min-[861px]:hidden"
          : "desktop h-full min-h-0 grid-rows-[minmax(0,1fr)] overflow-hidden pl-7 max-[860px]:hidden",
      )}
      aria-label={label}
      data-nav-swipe-exclusion
    >
      {mobile ? (
        <Card className="min-h-40 p-5">
          <p className="m-0 text-sm font-normal text-muted-foreground">Панель информации</p>
        </Card>
      ) : (
        <ScrollArea className="min-h-0">
          <Card className="min-h-40 p-5">
            <p className="m-0 text-sm font-normal text-muted-foreground">Панель информации</p>
          </Card>
        </ScrollArea>
      )}
    </aside>
  );
}
