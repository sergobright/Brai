"use client";

import { Badge } from "@/shared/ui/badge";
import { Card } from "@/shared/ui/card";
import { SECTION_GRID_CLASS } from "../../appModel";
import { cx } from "../../appUtils";

export function BraiCmdSection() {
  return (
    <section className={cx(SECTION_GRID_CLASS, "content-start items-start xl:w-1/2")} aria-label="Brai CMD">
      <Card className="grid w-full content-start gap-3 self-start p-4 sm:p-5">
        <Badge className="justify-self-start" variant="outline">Android</Badge>
        <p className="m-0 text-sm leading-5 text-muted-foreground">
          Brai CMD работает только в Android-приложении Brai. На телефоне этот пункт открывает нативные настройки команд поверх приложений,
          микрофона и доступа.
        </p>
        <p className="m-0 text-sm leading-5 text-muted-foreground">
          В веб-версии нет Android-разрешений и системного overlay, поэтому здесь нечего настраивать.
        </p>
      </Card>
    </section>
  );
}
