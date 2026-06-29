"use client";

import { formatGoalDuration, formatPercent } from "@/shared/time/format";
import type { GoalData } from "@/shared/types/timer";
import { Card } from "@/shared/ui/card";
import { Progress } from "@/shared/ui/progress";
import { BarChart, type TooltipProps } from "@/shared/ui/tremor-bar-chart";
import { SECTION_GRID_CLASS } from "../../appModel";
import { cx } from "../../appUtils";
import { goalSectionView } from "./goalModel";

export function GoalSection({ goal, todayKey }: { goal: GoalData; todayKey: string }) {
  const view = goalSectionView(goal, todayKey);
  return (
    <section className={cx(SECTION_GRID_CLASS, "min-w-0")} aria-label="Цели фокусировки">
      <div className="grid min-w-0 grid-cols-1 gap-3">
        <GoalProgressCard
          detail={`${formatGoalDuration(goal.completed_seconds)} из ${formatGoalDuration(goal.total_goal_seconds)}`}
          label="Общий прогресс"
          value={goal.percentage}
        />
        <GoalProgressCard
          detail={`${formatGoalDuration(view.todayCompletedSeconds)} из ${formatGoalDuration(goal.daily_goal_seconds)}`}
          label="Сегодня"
          value={view.todayPercentage}
          valueClassName="text-primary"
        />
      </div>

      <div className="grid min-w-0 grid-cols-4 gap-3 max-[860px]:grid-cols-[repeat(2,minmax(0,1fr))]">
        <Metric label="Выполнено" value={formatGoalDuration(goal.completed_seconds)} detail="суммарно" />
        <Metric label="Осталось" value={formatGoalDuration(goal.remaining_seconds)} detail={`${goal.remaining_days} дн.`} />
        <Metric
          label="Нужно в день"
          value={formatGoalDuration(goal.required_average_seconds_per_remaining_day)}
          detail="до финиша"
        />
        <Metric label="Дней закрыто" value={String(view.closedDays)} detail="из 28" />
      </div>

      <Card className="min-w-0 max-w-full overflow-hidden" data-goal-chart data-nav-swipe-exclusion>
        <div className="px-3 py-4">
          <BarChart
            className="h-64"
            data={view.chartData}
            index="date"
            categories={["Цель выполнена", "Время фокуса"]}
            colors={["primary", "muted"]}
            type="stacked"
            yAxisWidth={60}
            valueFormatter={formatGoalChartHours}
            customTooltip={GoalChartTooltip}
          />
        </div>
      </Card>
    </section>
  );
}

function GoalProgressCard({
  detail,
  label,
  value,
  valueClassName,
}: {
  detail: string;
  label: string;
  value: number;
  valueClassName?: string;
}) {
  const safeValue = Number.isFinite(value) ? Math.max(0, value) : 0;

  return (
    <Card className="min-w-0 gap-4 p-5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{label}</span>
        <span className={cx("text-sm tabular-nums", valueClassName)}>{formatPercent(safeValue)}</span>
      </div>
      <Progress max={Math.max(100, safeValue)} value={safeValue} />
      <small className="m-0 text-sm text-muted-foreground">{detail}</small>
    </Card>
  );
}

function formatGoalChartHours(value: number): string {
  return `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 }).format(value)} ч`;
}

function GoalChartTooltip({ active, payload, label }: TooltipProps) {
  if (!active || !payload?.length) return null;
  const visiblePayload =
    payload.find((item) => item.value > 0) ??
    payload.find((item) => item.category === "Время фокуса") ??
    payload[0];
  const source = visiblePayload.payload as {
    completedSeconds?: number;
    percentage?: number;
  };
  const isAchieved = visiblePayload.category === "Цель выполнена";
  return (
    <Card className="text-sm">
      <div className="border-b border-border px-4 py-2">
        <p className="font-semibold">{label}</p>
      </div>
      <div className="flex items-start justify-between gap-8 px-4 py-3">
        <div className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className={cx("size-2 shrink-0 rounded-xs", isAchieved ? "bg-primary" : "bg-muted-foreground")}
          />
          <p className="whitespace-nowrap text-muted-foreground">{visiblePayload.category}</p>
        </div>
        <div className="grid justify-items-end gap-1 text-right font-semibold tabular-nums">
          <span>{formatPercent(source.percentage ?? 0)} цели</span>
          <span>{formatGoalDuration(source.completedSeconds ?? 0)}</span>
        </div>
      </div>
    </Card>
  );
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <Card className="grid min-h-[124px] min-w-0 content-between p-[15px] max-[460px]:min-h-28">
      <span className="text-xs font-normal uppercase text-muted-foreground">{label}</span>
      <strong className="min-w-0 [overflow-wrap:anywhere] text-xl leading-[1.1] tabular-nums max-[460px]:text-lg">{value}</strong>
      <small className="m-0 text-muted-foreground">{detail}</small>
    </Card>
  );
}
