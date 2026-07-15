"use client";

import type { Ref } from "react";
import Image from "next/image";
import { CornerUpLeft, X } from "lucide-react";
import type { BraiChatEvent } from "@/shared/types/braiChat";
import { Button } from "@/shared/ui/button";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { cx } from "../../appUtils";
import { eventLabel, eventPayloadText, type BraiChatArtifact } from "./braiChatModel";

export type InspectorSelection = { kind: "artifact"; artifact: BraiChatArtifact } | { kind: "event"; event: BraiChatEvent };
export type InspectorInstance = "desktop" | "mobile";

export function BraiChatInspector({
  artifacts,
  attachmentUrl,
  events,
  focusRef,
  instance,
  mobile = false,
  onClose,
  onSelect,
  onSource,
  selection,
}: {
  artifacts: BraiChatArtifact[];
  attachmentUrl: (id: string) => string;
  events: BraiChatEvent[];
  focusRef?: Ref<HTMLElement>;
  instance: InspectorInstance;
  mobile?: boolean;
  onClose: () => void;
  onSelect: (selection: InspectorSelection) => void;
  onSource: (selection: InspectorSelection) => void;
  selection: InspectorSelection;
}) {
  const tabId = `brai-inspector-${selection.kind}-tab-${instance}`;
  const panelId = `brai-inspector-${selection.kind}-panel-${instance}`;
  const title = selection.kind === "artifact" ? selection.artifact.label : eventLabel(selection.event);
  const content = selection.kind === "artifact" ? selection.artifact.content : eventPayloadText(selection.event.safe_payload);
  const hasSource = selection.kind === "event" || Boolean(selection.artifact.sourceMessageId || selection.artifact.sourceEventId);

  return (
    <div className="grid h-full min-h-0 grid-rows-[auto_minmax(6rem,auto)_minmax(0,1fr)]">
      <header className="flex min-h-12 items-center gap-2 border-b border-border px-3">
        <div className="flex gap-1" role="tablist" aria-label="Разделы инспектора">
          <Button
            id={`brai-inspector-artifact-tab-${instance}`}
            type="button"
            role="tab"
            size="sm"
            variant={selection.kind === "artifact" ? "secondary" : "ghost"}
            aria-selected={selection.kind === "artifact"}
            aria-controls={`brai-inspector-artifact-panel-${instance}`}
            disabled={artifacts.length === 0}
            onClick={() => artifacts[0] && onSelect({ kind: "artifact", artifact: artifacts[0] })}
          >
            Артефакты
          </Button>
          <Button
            id={`brai-inspector-event-tab-${instance}`}
            type="button"
            role="tab"
            size="sm"
            variant={selection.kind === "event" ? "secondary" : "ghost"}
            aria-selected={selection.kind === "event"}
            aria-controls={`brai-inspector-event-panel-${instance}`}
            disabled={events.length === 0}
            onClick={() => events.at(-1) && onSelect({ kind: "event", event: events.at(-1)! })}
          >
            Детали
          </Button>
        </div>
        {!mobile ? <Button type="button" className="ml-auto" size="icon-sm" variant="ghost" aria-label="Закрыть инспектор" onClick={onClose}><X aria-hidden="true" /></Button> : null}
      </header>

      <ScrollArea className="min-h-0 border-b border-border" contentInset="none">
        <div className="grid gap-1 p-2" role="listbox" aria-label={selection.kind === "artifact" ? "Коллекция артефактов" : "Коллекция деталей"}>
          {selection.kind === "artifact" ? artifacts.map((artifact) => (
            <button
              key={artifact.id}
              id={inspectorArtifactAnchorId(artifact.id, instance)}
              type="button"
              role="option"
              aria-selected={selection.artifact.id === artifact.id}
              className={cx("rounded-md px-3 py-2 text-left text-sm hover:bg-accent focus-visible:outline-0 focus-visible:ring-2 focus-visible:ring-ring", selection.artifact.id === artifact.id && "bg-accent")}
              onClick={() => onSelect({ kind: "artifact", artifact })}
            >
              <span className="block truncate font-medium">{artifact.label}</span>
              <span className="block text-xs text-muted-foreground">{artifact.kind}</span>
            </button>
          )) : events.map((event) => (
            <button
              key={event.id}
              id={inspectorEventAnchorId(event.id, instance)}
              type="button"
              role="option"
              aria-selected={selection.event.id === event.id}
              className={cx("rounded-md px-3 py-2 text-left text-sm hover:bg-accent focus-visible:outline-0 focus-visible:ring-2 focus-visible:ring-ring", selection.event.id === event.id && "bg-accent")}
              onClick={() => onSelect({ kind: "event", event })}
            >
              <span className="block truncate font-medium">{eventLabel(event)}</span>
              <span className="block truncate text-xs text-muted-foreground">{event.type} · {event.sequence}</span>
            </button>
          ))}
        </div>
      </ScrollArea>

      <section ref={focusRef} id={panelId} role="tabpanel" aria-labelledby={tabId} tabIndex={-1} className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] outline-none">
        <div className="flex min-h-12 items-center gap-2 border-b border-border px-4 py-2">
          <h2 className="m-0 min-w-0 flex-1 truncate text-sm font-semibold">{title}</h2>
          {hasSource ? (
            <Button type="button" size="sm" variant="ghost" onClick={() => onSource(selection)}>
              <CornerUpLeft aria-hidden="true" />К источнику
            </Button>
          ) : null}
        </div>
        <ScrollArea className="min-h-0" contentInset="none">
          {selection.kind === "artifact" && selection.artifact.kind === "image" && selection.artifact.attachmentId ? (
            <div className="grid gap-3 p-4">
              <Image
                unoptimized
                src={attachmentUrl(selection.artifact.attachmentId)}
                alt={selection.artifact.label}
                width={1200}
                height={900}
                className="h-auto max-h-[70dvh] w-full object-contain"
              />
              <pre className="m-0 whitespace-pre-wrap break-words font-mono text-sm">{content}</pre>
            </div>
          ) : (
            <pre className="m-0 whitespace-pre-wrap break-words p-4 font-mono text-sm">{content}</pre>
          )}
        </ScrollArea>
      </section>
    </div>
  );
}

/** Returns the per-renderer DOM anchor for an inspector event row. */
export function inspectorEventAnchorId(eventId: string, instance: InspectorInstance): string {
  return `brai-event-${eventId}-${instance}`;
}

function inspectorArtifactAnchorId(artifactId: string, instance: InspectorInstance): string {
  return `brai-artifact-${artifactId}-${instance}`;
}
