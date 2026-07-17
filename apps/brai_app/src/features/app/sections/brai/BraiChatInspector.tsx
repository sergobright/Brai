"use client";

import { useEffect, useMemo } from "react";
import { BookOpen, Code2, CornerUpLeft, Eye } from "lucide-react";
import { Button } from "@/shared/ui/button";
import { MarkdownContent } from "@/shared/ui/markdown-content";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { cx } from "../../appUtils";
import { BraiChatImage } from "./BraiChatImage";
import { workspaceArtifacts, type BraiChatArtifact, type BraiWorkspaceMode } from "./braiChatModel";

export type WorkspaceInstance = "desktop" | "mobile";

const MODE_COPY: Record<BraiWorkspaceMode, { empty: string; label: string; icon: typeof Eye }> = {
  preview: { empty: "Изображения и визуальные результаты появятся здесь", label: "Preview", icon: Eye },
  code: { empty: "Код, diff и файлы появятся здесь", label: "Code", icon: Code2 },
  docs: { empty: "Документы и большие Markdown-ответы появятся здесь", label: "Docs", icon: BookOpen },
};

export function BraiChatWorkspace({
  artifacts,
  loadAttachment,
  instance,
  mode,
  onSource,
  showHeading = true,
  targetId,
}: {
  artifacts: BraiChatArtifact[];
  loadAttachment: (id: string, download?: boolean) => Promise<Blob>;
  instance: WorkspaceInstance;
  mode: BraiWorkspaceMode;
  onSource: (artifact: BraiChatArtifact) => void;
  showHeading?: boolean;
  targetId?: string | null;
}) {
  const visibleArtifacts = useMemo(() => workspaceArtifacts(artifacts, mode), [artifacts, mode]);
  const copy = MODE_COPY[mode];
  const Icon = copy.icon;

  useEffect(() => {
    if (!targetId) return;
    const frame = window.requestAnimationFrame(() => {
      const target = document.getElementById(workspaceArtifactAnchorId(targetId, instance));
      target?.scrollIntoView({ block: "center" });
      target?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [instance, mode, targetId, visibleArtifacts]);

  return (
    <div className={cx("grid h-full min-h-0", showHeading ? "grid-rows-[auto_minmax(0,1fr)]" : "grid-rows-[minmax(0,1fr)]")}>
      {showHeading ? (
        <header className="mb-3 flex min-h-9 items-center gap-3">
          <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
          <h2 className="m-0 text-xl font-semibold leading-tight">{copy.label}</h2>
          <span className="text-xs text-muted-foreground">{visibleArtifacts.length || ""}</span>
        </header>
      ) : null}
      {visibleArtifacts.length === 0 ? (
        <div className="grid min-h-0 place-items-center p-8 text-center">
          <div className="grid max-w-sm justify-items-center gap-3 text-muted-foreground">
            <Icon className="size-8" aria-hidden="true" />
            <p className="m-0 text-sm">{copy.empty}</p>
          </div>
        </div>
      ) : (
        <ScrollArea className="min-h-0" contentInset="balanced">
          <div className="grid gap-4 pr-1">
            {visibleArtifacts.map((artifact) => (
              <article
                key={artifact.id}
                id={workspaceArtifactAnchorId(artifact.id, instance)}
                tabIndex={-1}
                className={cx(
                  "min-w-0 overflow-hidden rounded-lg border border-border bg-background outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  targetId === artifact.id && "ring-2 ring-ring",
                )}
              >
                <header className="flex min-h-11 items-center gap-2 border-b border-border px-3 py-2">
                  <h3 className="m-0 min-w-0 flex-1 truncate text-sm font-medium">{artifact.label}</h3>
                  {artifact.sourceMessageId || artifact.sourceEventId ? (
                    <Button type="button" size="sm" variant="ghost" onClick={() => onSource(artifact)}>
                      <CornerUpLeft aria-hidden="true" />К сообщению
                    </Button>
                  ) : null}
                </header>
                <WorkspaceArtifactContent artifact={artifact} loadAttachment={loadAttachment} />
              </article>
            ))}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}

function WorkspaceArtifactContent({ artifact, loadAttachment }: {
  artifact: BraiChatArtifact;
  loadAttachment: (id: string, download?: boolean) => Promise<Blob>;
}) {
  if (artifact.kind === "image" && artifact.attachmentId) {
    return (
      <div className="p-4">
        <BraiChatImage attachmentId={artifact.attachmentId} label={artifact.label} loadBlob={loadAttachment} />
      </div>
    );
  }
  if (artifact.kind === "markdown") {
    return <MarkdownContent source={artifact.content} className="p-4" />;
  }
  return (
    <div className="max-h-[70dvh] min-h-24 overflow-auto">
      <pre className="m-0 min-w-max whitespace-pre p-4 font-mono text-sm leading-relaxed">{artifact.content}</pre>
    </div>
  );
}

/** Returns the stable DOM anchor for a projected workspace artifact. */
export function workspaceArtifactAnchorId(artifactId: string, instance: WorkspaceInstance): string {
  return `brai-workspace-${artifactId}-${instance}`;
}
