"use client";

import { Card, CardContent } from "@/shared/ui/card";
import { SECTION_GRID_CLASS } from "../../appModel";

export function ProfileSection() {
  return (
    <section className={SECTION_GRID_CLASS} aria-label="Профиль">
      <Card className="max-w-3xl">
        <CardContent className="py-6 text-sm text-muted-foreground">
          Профиль пока пуст.
        </CardContent>
      </Card>
    </section>
  );
}
