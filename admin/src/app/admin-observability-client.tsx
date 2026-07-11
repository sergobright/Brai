"use client";

import { useRouter } from "next/navigation";
import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";
import { Maximize2, Minus, Plus, RotateCcw, Scan } from "lucide-react";
import { Button } from "@/shared/ui/button";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/shared/ui/table";

const DEFAULT_DIAGRAM_SIZE = { width: 1200, height: 680 };

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
