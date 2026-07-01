"use client";

import { useEffect, useState, type ReactNode, type WheelEvent } from "react";
import { ChevronDown, Crown, Eye, Sparkles } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { formatDuration, formatHumanDuration, formatPercent, formatRussianDate, moscowTime } from "@/shared/time/format";
import type { GoalData, HistoryData, TimerState } from "@/shared/types/timer";
import { BorderTrail } from "@/shared/ui/border-trail";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/shared/ui/collapsible";
import EvilEye from "@/shared/ui/EvilEye/EvilEye";
import Galaxy from "@/shared/ui/galaxy";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { SlidingNumber } from "@/shared/ui/sliding-number";
import { TextMorph } from "@/shared/ui/text-morph";
import type { FocusBackgroundMode, FocusContextPanel } from "../../appModel";
import { SECTION_GRID_CLASS } from "../../appModel";
import { cx } from "../../appUtils";
import { EmptyState, MobileContextSheet } from "../../chrome/AppChrome";
import { GoalSection } from "../goal/GoalSection";
import { historyGroupsView, timerClockParts } from "./focusModel";
import { FocusHistoryTable } from "./FocusHistoryTable";

const FOCUS_GOAL_LABEL = "Цели фокусировки";
const FOCUS_HISTORY_LABEL = "История фокуса";

export function FocusSection({
  state,
  history,
  goal,
  todayKey,
  contextPanel,
  active,
  busy,
  background = "galaxy",
  onStart,
  onStop,
  onDeleteSession,
  onEditInterval,
  onEditSession,
  onBackground = () => undefined,
}: {
  state: TimerState;
  history: HistoryData;
  goal: GoalData;
  todayKey: string;
  contextPanel: FocusContextPanel;
  active: boolean;
  busy: boolean;
  background?: FocusBackgroundMode;
  onStart: () => void;
  onStop: () => void;
  onDeleteSession?: (sessionId: string) => void | Promise<void>;
  onEditInterval?: (intervalId: string, sessionId: string, startedAtUtc: string, endedAtUtc: string) => void | Promise<void>;
  onEditSession?: (sessionId: string, startedAtUtc: string, endedAtUtc: string) => void | Promise<void>;
  onBackground?: (background: FocusBackgroundMode) => void;
}) {
  const timerPane = (
    <ScrollArea
      scrollbar={false}
      className="focus-timer-pane relative z-10 h-full min-h-0 min-w-0 w-full [&>[data-slot=scroll-area-viewport]]:scroll-pb-36 [&>[data-slot=scroll-area-viewport]>div]:h-full"
      data-nav-swipe-exclusion
      onWheelCapture={keepWheelInsideTimerPane}
    >
      <TimerSection
        state={state}
        active={active}
        busy={busy}
        centered={contextPanel === "none"}
        background={background}
        onStart={onStart}
        onStop={onStop}
        onBackground={onBackground}
      />
    </ScrollArea>
  );

  return (
    <section
      className={cx(
        "focus-section relative isolate grid h-full min-h-0 gap-7 max-[860px]:block",
        contextPanel === "none"
          ? "grid-cols-[minmax(0,1fr)] place-items-center overflow-hidden max-[860px]:overflow-visible"
          : "grid-cols-[minmax(0,1fr)_minmax(0,1fr)] overflow-hidden max-[860px]:overflow-visible",
      )}
      aria-label="Фокус"
    >
      {timerPane}
      {contextPanel === "history" ? <FocusDesktopPanel label={FOCUS_HISTORY_LABEL}><HistorySection history={history} goal={goal} onDeleteSession={onDeleteSession} onEditInterval={onEditInterval} onEditSession={onEditSession} /></FocusDesktopPanel> : null}
      {contextPanel === "goal" ? <FocusDesktopPanel label={FOCUS_GOAL_LABEL}><GoalSection goal={goal} todayKey={todayKey} /></FocusDesktopPanel> : null}
    </section>
  );
}

export function FocusContextPanelSheet({
  panel,
  history,
  goal,
  todayKey,
  onClose,
  onCloseStart,
  onDeleteSession,
  onEditInterval,
  onEditSession,
}: {
  panel: Exclude<FocusContextPanel, "none">;
  history: HistoryData;
  goal: GoalData;
  todayKey: string;
  onClose: () => void;
  onCloseStart?: () => void;
  onDeleteSession?: (sessionId: string) => void | Promise<void>;
  onEditInterval?: (intervalId: string, sessionId: string, startedAtUtc: string, endedAtUtc: string) => void | Promise<void>;
  onEditSession?: (sessionId: string, startedAtUtc: string, endedAtUtc: string) => void | Promise<void>;
}) {
  const label = panel === "goal" ? FOCUS_GOAL_LABEL : FOCUS_HISTORY_LABEL;
  return (
    <MobileContextSheet label={label} className={`focus-${panel}-backdrop`} onClose={onClose} onCloseStart={onCloseStart}>
      {panel === "goal" ? <GoalSection goal={goal} todayKey={todayKey} /> : <HistorySection history={history} goal={goal} onDeleteSession={onDeleteSession} onEditInterval={onEditInterval} onEditSession={onEditSession} />}
    </MobileContextSheet>
  );
}

function FocusDesktopPanel({ label, children }: { label: string; children: ReactNode }) {
  return (
    <aside className="focus-context-pane relative z-10 grid h-full min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] max-[860px]:hidden" aria-label={label} data-galaxy-interaction-block>
      <h2 className="mb-3 mt-0 text-xl font-semibold leading-tight">{label}</h2>
      <ScrollArea className="min-h-0">{children}</ScrollArea>
    </aside>
  );
}

function keepWheelInsideTimerPane(event: WheelEvent<HTMLElement>) {
  const viewport = event.currentTarget.querySelector<HTMLElement>("[data-slot='scroll-area-viewport']");
  if (!viewport || viewport.scrollHeight <= viewport.clientHeight) return;
  const deltaY = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaMode === 2 ? event.deltaY * viewport.clientHeight : event.deltaY;
  if (deltaY === 0) return;
  const currentScrollTop = viewport.scrollTop;
  const nextScrollTop = Math.max(0, Math.min(currentScrollTop + deltaY, viewport.scrollHeight - viewport.clientHeight));
  if (nextScrollTop === currentScrollTop) return;
  viewport.scrollTop = nextScrollTop;
  event.preventDefault();
  event.stopPropagation();
}

const TIMER_GALAXY_IDLE = {
  density: 0.5,
  glowIntensity: 0.2,
  saturation: 0,
  hueShift: 140,
  twinkleIntensity: 0,
  rotationSpeed: 0,
  repulsionStrength: 1,
  autoCenterRepulsion: 0,
  starSpeed: 0.1,
  speed: 0.3,
  mouseRepulsion: false,
  mouseInteraction: false,
};

const TIMER_GALAXY_ACTIVE = {
  density: 2,
  glowIntensity: 0.2,
  saturation: 0,
  hueShift: 140,
  twinkleIntensity: 0.3,
  rotationSpeed: 0.1,
  repulsionStrength: 2.5,
  autoCenterRepulsion: 0,
  starSpeed: 1,
  speed: 1,
  mouseRepulsion: false,
  mouseInteraction: false,
};

const TIMER_EVIL_EYE_IDLE = {
  flameSpeed: 0.25,
  scale: 0.4,
};

const TIMER_EVIL_EYE_ACTIVE = {
  flameSpeed: 1,
  scale: 0.8,
};

const FOCUS_BACKGROUND_BLOCK_SELECTOR = "[data-galaxy-interaction-block], button, a, input, textarea, select, [role='button'], [role='slider']";

export function FocusBackground({ active, mode }: { active: boolean; mode: FocusBackgroundMode }) {
  const galaxyProps = active ? TIMER_GALAXY_ACTIVE : TIMER_GALAXY_IDLE;
  const evilEyeProps = active ? TIMER_EVIL_EYE_ACTIVE : TIMER_EVIL_EYE_IDLE;
  const [transition, setTransition] = useState<{ mode: FocusBackgroundMode; previous: FocusBackgroundMode | null }>(() => ({
    mode,
    previous: null,
  }));
  let currentTransition = transition;

  if (currentTransition.mode !== mode) {
    currentTransition = { mode, previous: currentTransition.mode };
    setTransition(currentTransition);
  }

  useEffect(() => {
    if (transition.previous == null) return;
    const timeoutId = window.setTimeout(() => {
      setTransition((current) => (
        current.mode === transition.mode ? { mode: current.mode, previous: null } : current
      ));
    }, 3000);
    return () => window.clearTimeout(timeoutId);
  }, [transition.mode, transition.previous]);

  const renderedModes = currentTransition.previous == null
    ? [currentTransition.mode]
    : [currentTransition.previous, currentTransition.mode];

  return (
    <div className="focus-background absolute inset-0 z-0 bg-background" aria-hidden="true">
      {renderedModes.includes("galaxy") ? (
        <div
          className={cx(
            "timer-galaxy-background absolute inset-0 invert transition-opacity duration-[1500ms] ease-in-out dark:invert-0",
            currentTransition.mode === "galaxy" ? "opacity-100 delay-[1500ms]" : "opacity-0 delay-0",
          )}
        >
          <Galaxy {...galaxyProps} interactionBlockSelector={FOCUS_BACKGROUND_BLOCK_SELECTOR} />
        </div>
      ) : null}
      {renderedModes.includes("evil-eye") ? (
        <div
          className={cx(
            "timer-evil-eye-background absolute inset-0 invert transition-opacity duration-[1500ms] ease-in-out dark:invert-0",
            currentTransition.mode === "evil-eye" ? "opacity-100 delay-[1500ms]" : "opacity-0 delay-0",
          )}
        >
          <EvilEye {...evilEyeProps} interactionBlockSelector={FOCUS_BACKGROUND_BLOCK_SELECTOR} />
        </div>
      ) : null}
    </div>
  );
}

function TimerSection({
  state,
  active,
  busy,
  centered,
  background,
  onStart,
  onStop,
  onBackground,
}: {
  state: TimerState;
  active: boolean;
  busy: boolean;
  centered: boolean;
  background: FocusBackgroundMode;
  onStart: () => void;
  onStop: () => void;
  onBackground: (background: FocusBackgroundMode) => void;
}) {
  const elapsedSeconds = active ? Math.max(0, Math.floor(state.elapsed_seconds ?? 0)) : 0;
  const duration = timerClockParts(elapsedSeconds);
  const timerDigitsKey = active ? state.active_session?.id ?? "active" : "idle";

  return (
    <section
      className={cx(
        "timer-screen box-content grid h-full min-h-full grid-rows-[minmax(100%,auto)_auto] gap-6 pb-36",
        centered && "w-full justify-items-center",
        active && "is-active",
      )}
      aria-label="Фокус"
    >
      <div className="timer-primary grid h-full min-h-0 w-full grid-rows-[minmax(0,1fr)_auto_minmax(0,1fr)] justify-items-center">
        <Card
          className={cx(
            "timer-face row-start-2 max-w-full justify-self-center overflow-hidden bg-card/60",
            centered ? "w-[min(640px,100%)] p-[clamp(20px,5vw,34px)]" : "w-full p-5",
            active && "is-active border-primary/40",
          )}
        >
          {active ? (
            <BorderTrail
              className="timer-border-trail"
              style={{
                boxShadow:
                  "0px 0px 60px 30px rgb(255 255 255 / 50%), 0 0 100px 60px rgb(0 0 0 / 50%), 0 0 140px 90px rgb(0 0 0 / 50%)",
              }}
              size={100}
              transition={{ repeat: Infinity, duration: 10, ease: "linear" }}
            />
          ) : null}
          <div
            key={timerDigitsKey}
            className={cx(
              "timer-digits my-[24px] mb-[22px] text-center whitespace-nowrap text-5xl font-semibold leading-[0.95] tabular-nums",
              centered && "sm:text-6xl md:text-7xl lg:text-8xl",
            )}
            aria-label={formatDuration(elapsedSeconds)}
          >
            <div aria-hidden="true" className="inline-flex items-center gap-0.5">
              <div data-slot="timer-hours" className="inline-flex">
                <SlidingNumber value={duration.hours} padStart instant={!active} snapKey={elapsedSeconds} />
              </div>
              <span>:</span>
              <div data-slot="timer-minutes" className="inline-flex">
                <SlidingNumber value={duration.minutes} padStart instant={!active} snapKey={elapsedSeconds} />
              </div>
              <span>:</span>
              <div data-slot="timer-seconds" className="inline-flex">
                <SlidingNumber value={duration.seconds} padStart instant={!active} snapKey={elapsedSeconds} />
              </div>
            </div>
          </div>
        </Card>
        <div className="pointer-events-none relative row-start-3 h-full w-full" aria-hidden="true">
          <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
            <AnimatePresence initial={false}>
              {!active ? (
                <motion.div
                  className="timer-scroll-hint text-muted-foreground/55"
                  initial={{ opacity: 0, y: -2, scale: 0.96 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 8, scale: 0.96 }}
                  transition={{ duration: 0.22, ease: "easeOut" }}
                >
                  <ChevronDown className="size-8" aria-hidden="true" />
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>
        </div>
      </div>

      <div
        className={cx(
          "timer-actions grid w-[min(640px,100%)] justify-items-center gap-2 justify-self-center",
        )}
        data-galaxy-interaction-block
      >
        <p className={cx("session-line m-0 text-xs font-normal text-muted-foreground/55 tabular-nums", !active && "invisible")} aria-hidden={!active}>
          Started {moscowTime(state.active_session?.started_at_utc)}
        </p>
        <Button
          type="button"
          variant={active ? "destructive" : "default"}
          className={cx(
            "action-button h-10 w-[120px] rounded-full px-4 text-base shadow-xs whitespace-nowrap max-[860px]:w-full",
            active && "text-destructive-foreground",
          )}
          onClick={active ? onStop : onStart}
          disabled={busy}
        >
          <TextMorph as="span" className="inline-flex whitespace-nowrap">{active ? "Завершить" : "Запустить"}</TextMorph>
        </Button>
        <div className="focus-background-toggle mt-3 flex items-center justify-center gap-2" role="group" aria-label="Фон фокуса">
          <Button
            type="button"
            size="icon"
            variant="outline"
            className="text-muted-foreground aria-pressed:border-primary/50 aria-pressed:text-foreground"
            aria-label="Фон Galaxy"
            aria-pressed={background === "galaxy"}
            onClick={() => onBackground("galaxy")}
          >
            <Sparkles className="size-4" aria-hidden="true" />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="outline"
            className="text-muted-foreground aria-pressed:border-primary/50 aria-pressed:text-foreground"
            aria-label="Фон Evil Eye"
            aria-pressed={background === "evil-eye"}
            onClick={() => onBackground("evil-eye")}
          >
            <Eye className="size-4" aria-hidden="true" />
          </Button>
        </div>
      </div>
    </section>
  );
}

function HistorySection({
  history,
  goal,
  onDeleteSession,
  onEditInterval,
  onEditSession,
}: {
  history: HistoryData;
  goal: GoalData;
  onDeleteSession?: (sessionId: string) => void | Promise<void>;
  onEditInterval?: (intervalId: string, sessionId: string, startedAtUtc: string, endedAtUtc: string) => void | Promise<void>;
  onEditSession?: (sessionId: string, startedAtUtc: string, endedAtUtc: string) => void | Promise<void>;
}) {
  const groups = historyGroupsView(history, goal);
  if (groups.length === 0) {
    return (
      <EmptyState
        emoji="📜"
        title="Сессий пока нет"
        body="История появится после завершения первой сессии."
      />
    );
  }

  return (
    <section className={cx(SECTION_GRID_CLASS, "min-w-0")} aria-label="История фокуса">
      {groups.map((group) => {
        return (
          <div
            className="history-group relative flex w-full min-w-0 flex-col rounded-2xl bg-muted/72 p-1"
            data-slot="frame"
            key={group.date}
          >
            <Collapsible defaultOpen>
              <header className="flex flex-row items-center justify-between gap-2 px-2 py-2" data-slot="frame-panel-header">
                <CollapsibleTrigger className="inline-flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm font-semibold outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[state=open]:[&_svg]:rotate-180">
                  <ChevronDown className="size-4 shrink-0 transition-transform" aria-hidden="true" />
                  <span className="min-w-0 truncate">{formatRussianDate(group.date)}</span>
                </CollapsibleTrigger>
                <div className="flex shrink-0 items-center justify-end gap-1.5">
                  {group.achieved ? <Crown className="size-3.5 shrink-0 text-primary" aria-label="Цель достигнута" /> : null}
                  <span className="w-12 text-right text-xs font-normal text-primary tabular-nums">{formatPercent(group.goalPercent)}</span>
                  <span className="w-24 max-w-24 text-right text-sm font-semibold text-primary tabular-nums">{formatHumanDuration(group.totalSeconds)}</span>
                </div>
              </header>
              <CollapsibleContent>
                <FocusHistoryTable allSessions={history.sessions} sessions={group.sessions} onDeleteSession={onDeleteSession} onEditInterval={onEditInterval} onEditSession={onEditSession} />
              </CollapsibleContent>
            </Collapsible>
          </div>
        );
      })}
    </section>
  );
}
