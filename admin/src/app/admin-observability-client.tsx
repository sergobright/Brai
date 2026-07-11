"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Maximize2, Minus, Plus, RotateCcw, Scan } from "lucide-react";
import { Button } from "@/shared/ui/button";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/shared/ui/table";

const DEFAULT_DIAGRAM_SIZE = { width: 1200, height: 680 };
const TRANSIENT_FEEDBACK_MS = 900;

type FeedbackState = {
  kind: "done" | "loading";
  routeKey: string;
  text: string;
};

export function AdminInteractionFeedback() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const routeKey = `${pathname}?${searchParams.toString()}`;
  const [feedback, setFeedback] = useState<FeedbackState | null>(null);
  const timeoutRef = useRef<number | null>(null);

  const clearTimer = useCallback(() => {
    if (timeoutRef.current === null) return;
    window.clearTimeout(timeoutRef.current);
    timeoutRef.current = null;
  }, []);

  const showFeedback = useCallback((next: Omit<FeedbackState, "routeKey">) => {
    clearTimer();
    setFeedback({ ...next, routeKey });
    if (next.kind === "done") {
      timeoutRef.current = window.setTimeout(() => setFeedback(null), TRANSIENT_FEEDBACK_MS);
    }
  }, [clearTimer, routeKey]);

  useEffect(() => {
    return clearTimer;
  }, [clearTimer]);

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (!(event.target instanceof Element)) return;

      const control = event.target.closest("a[href], button, [role='button'], input[type='button'], input[type='submit']");
      if (!(control instanceof HTMLElement) || isUnavailableControl(control)) return;

      const link = control instanceof HTMLAnchorElement ? control : control.closest("a[href]");
      if (link instanceof HTMLAnchorElement) {
        if (link.target || link.download) return;
        const url = new URL(link.href, window.location.href);
        if (url.origin !== window.location.origin) return;
        showFeedback(isSameUrl(url) ? { kind: "done", text: "Уже открыто" } : { kind: "loading", text: "Загружаю" });
        return;
      }

      const buttonType = control.getAttribute("type") ?? "submit";
      if (buttonType === "submit" && control.closest("form")) {
        showFeedback({ kind: "loading", text: "Применяю" });
        return;
      }

      showFeedback({ kind: "done", text: "Действие принято" });
    };

    const onSubmit = (event: SubmitEvent) => {
      if (event.defaultPrevented) return;
      showFeedback({ kind: "loading", text: "Применяю" });
    };

    document.addEventListener("click", onClick, true);
    document.addEventListener("submit", onSubmit, true);
    return () => {
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("submit", onSubmit, true);
    };
  }, [showFeedback]);

  const visibleFeedback = feedback?.routeKey === routeKey ? feedback : null;
  if (!visibleFeedback) return null;

  return (
    <div className="pointer-events-none fixed right-3 top-3 z-50 flex max-w-[calc(100vw-1.5rem)] items-center gap-2 rounded-md border bg-popover px-3 py-2 text-sm font-medium text-popover-foreground shadow-lg" role="status" aria-live="polite">
      {visibleFeedback.kind === "loading" ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <span className="size-2 rounded-full bg-primary" aria-hidden="true" />}
      <span>{visibleFeedback.text}</span>
    </div>
  );
}

export function AutoRefresh({
  enabled,
  intervalMs,
}: {
  enabled: boolean;
  intervalMs: number;
}) {
  const router = useRouter();
  useEffect(() => {
    if (!enabled) return undefined;
    const tick = () => {
      if (document.visibilityState === "visible") router.refresh();
    };
    const timer = window.setInterval(tick, intervalMs);
    return () => window.clearInterval(timer);
  }, [enabled, intervalMs, router]);
  return null;
}

export function DiagramViewport({
  alt,
  dataUrl,
  source,
  steps,
  summary,
  title,
}: {
  alt: string;
  dataUrl: string | null;
  source: string;
  steps?: Array<Record<string, unknown>>;
  summary: string;
  title: string;
}) {
  const [zoom, setZoom] = useState(1);
  const [fitZoom, setFitZoom] = useState(1);
  const [imageSize, setImageSize] = useState(DEFAULT_DIAGRAM_SIZE);
  const frameRef = useRef<HTMLDivElement>(null);
  const fitToFrame = useCallback((size = imageSize) => {
    const frame = frameRef.current;
    if (!frame || !size.width || !size.height) return;
    const availableWidth = Math.max(1, frame.clientWidth - 24);
    const availableHeight = Math.max(1, frame.clientHeight - 24);
    const nextFit = Math.min(1, availableWidth / size.width, availableHeight / size.height);
    const safeFit = Number.isFinite(nextFit) ? Math.max(0.05, nextFit) : 1;
    setFitZoom(safeFit);
    setZoom(safeFit);
  }, [imageSize]);
  const fit = () => setZoom(fitZoom);
  const fullscreen = () => {
    void frameRef.current?.requestFullscreen?.();
  };
  const scaledWidth = imageSize.width * zoom;
  const scaledHeight = imageSize.height * zoom;

  useEffect(() => {
    if (!dataUrl) return undefined;
    fitToFrame();
    const frame = frameRef.current;
    if (!frame) return undefined;
    const observer = new ResizeObserver(() => fitToFrame());
    observer.observe(frame);
    return () => observer.disconnect();
  }, [dataUrl, fitToFrame]);

  return (
    <section className="grid gap-3" aria-label={title}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="m-0 text-base font-semibold">{title}</h3>
          <p className="m-0 text-sm leading-6 text-muted-foreground">{summary}</p>
        </div>
        <div className="flex flex-wrap gap-2" aria-label="Управление диаграммой">
          <Button onClick={() => setZoom((value) => Math.max(0.05, value - 0.1))} size="icon-sm" title="Уменьшить" type="button" variant="outline">
            <Minus className="size-4" />
            <span className="sr-only">Уменьшить</span>
          </Button>
          <Button onClick={() => setZoom((value) => Math.min(3, value + 0.1))} size="icon-sm" title="Увеличить" type="button" variant="outline">
            <Plus className="size-4" />
            <span className="sr-only">Увеличить</span>
          </Button>
          <Button onClick={fit} size="icon-sm" title="Вписать" type="button" variant="outline">
            <Scan className="size-4" />
            <span className="sr-only">Вписать</span>
          </Button>
          <Button onClick={() => setZoom(1)} size="icon-sm" title="Сбросить" type="button" variant="outline">
            <RotateCcw className="size-4" />
            <span className="sr-only">Сбросить</span>
          </Button>
          <Button onClick={fullscreen} size="icon-sm" title="Fullscreen" type="button" variant="outline">
            <Maximize2 className="size-4" />
            <span className="sr-only">Fullscreen</span>
          </Button>
        </div>
      </div>
      <div ref={frameRef} className="min-h-[65vh] min-w-0 rounded-lg border bg-background p-3">
        <ScrollArea className="h-[65vh] min-h-[680px] min-w-0" contentInset="none" scrollbars="both">
          {dataUrl ? (
            <div style={{ height: scaledHeight, width: scaledWidth }}>
              <Image
                alt={alt}
                className="block max-w-none origin-top-left"
                height={imageSize.height}
                onLoad={(event) => {
                  const next = {
                    height: event.currentTarget.naturalHeight || DEFAULT_DIAGRAM_SIZE.height,
                    width: event.currentTarget.naturalWidth || DEFAULT_DIAGRAM_SIZE.width,
                  };
                  setImageSize(next);
                  requestAnimationFrame(() => fitToFrame(next));
                }}
                unoptimized
                src={dataUrl}
                style={{
                  height: imageSize.height,
                  transform: `scale(${zoom})`,
                  transformOrigin: "top left",
                  width: imageSize.width,
                }}
                width={imageSize.width}
              />
            </div>
          ) : (
            <div className="grid min-w-[1200px] gap-3">
              <p className="m-0 text-sm text-muted-foreground">Kroki недоступен. Ниже показаны таблица шагов и Mermaid source.</p>
              {steps?.length ? <StepFallbackTable steps={steps} /> : null}
              <details className="rounded-lg border bg-muted/20 p-3">
                <summary className="cursor-pointer text-sm font-medium">Mermaid source</summary>
                <pre className="mb-0 mt-3 whitespace-pre-wrap break-words text-xs">{source}</pre>
              </details>
            </div>
          )}
        </ScrollArea>
      </div>
    </section>
  );
}

function isUnavailableControl(control: HTMLElement) {
  if (control.getAttribute("aria-disabled") === "true") return true;
  return (control instanceof HTMLButtonElement || control instanceof HTMLInputElement) && control.disabled;
}

function isSameUrl(url: URL) {
  return url.pathname === window.location.pathname && url.search === window.location.search && url.hash === window.location.hash;
}

function StepFallbackTable({ steps }: { steps: Array<Record<string, unknown>> }) {
  return (
    <Table variant="card">
      <TableHeader>
        <TableRow>
          {["step", "attempt", "status", "started", "completed", "duration"].map((column) => (
            <TableHead key={column}>{column}</TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {steps.map((step, index) => (
          <TableRow key={`${String(step.step_key ?? index)}:${String(step.attempt ?? "")}`}>
            <TableCell className="font-mono">{String(step.step_key ?? "")}</TableCell>
            <TableCell>{String(step.attempt ?? "")}</TableCell>
            <TableCell>{String(step.status ?? "")}</TableCell>
            <TableCell>{String(step.started_at_utc ?? "")}</TableCell>
            <TableCell>{String(step.completed_at_utc ?? "")}</TableCell>
            <TableCell>{String(step.duration_ms ?? "")}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
