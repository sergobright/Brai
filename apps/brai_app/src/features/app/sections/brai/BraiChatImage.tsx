"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/shared/ui/button";
import { cx } from "../../appUtils";
import { ImageViewerDialog } from "../../chrome/ImageViewerDialog";

export function BraiChatImage({
  attachmentId,
  className,
  label,
  loadBlob,
}: {
  attachmentId: string;
  className?: string;
  label: string;
  loadBlob: (id: string, download?: boolean) => Promise<Blob>;
}) {
  const [loadState, setLoadState] = useState<{ key: string; objectUrl: string; failed: boolean } | null>(null);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [loadVersion, setLoadVersion] = useState(0);
  const objectUrlRef = useRef("");

  const releaseObjectUrl = useCallback(() => {
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    objectUrlRef.current = "";
  }, []);

  useEffect(() => {
    let cancelled = false;
    releaseObjectUrl();
    const key = `${attachmentId}:${loadVersion}`;
    void loadBlob(attachmentId).then((blob) => {
      if (cancelled) return;
      if (!blob.type.startsWith("image/") || blob.size === 0) throw new Error("invalid_image_blob");
      const nextUrl = URL.createObjectURL(blob);
      objectUrlRef.current = nextUrl;
      setLoadState({ key, objectUrl: nextUrl, failed: false });
    }).catch(() => {
      if (!cancelled) setLoadState({ key, objectUrl: "", failed: true });
    });
    return () => {
      cancelled = true;
      releaseObjectUrl();
    };
  }, [attachmentId, loadBlob, loadVersion, releaseObjectUrl]);
  const currentKey = `${attachmentId}:${loadVersion}`;
  const objectUrl = loadState?.key === currentKey ? loadState.objectUrl : "";
  const failed = loadState?.key === currentKey && loadState.failed;

  const download = useCallback(async () => {
    try {
      const blob = await loadBlob(attachmentId, true);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = label || "brai-image";
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch {
      releaseObjectUrl();
      setLoadState({ key: currentKey, objectUrl: "", failed: true });
    }
  }, [attachmentId, currentKey, label, loadBlob, releaseObjectUrl]);

  if (failed) {
    return (
      <div className={cx("grid min-h-36 place-items-center gap-2 rounded-lg border border-dashed border-border p-5 text-center text-sm text-muted-foreground", className)}>
        <span>Изображение пока не загрузилось</span>
        <Button type="button" size="sm" variant="outline" onClick={() => setLoadVersion((value) => value + 1)}>
          <RefreshCw aria-hidden="true" />Повторить
        </Button>
      </div>
    );
  }

  if (!objectUrl) {
    return <div className={cx("grid min-h-36 place-items-center rounded-lg border border-border", className)}><Loader2 className="size-5 animate-spin text-muted-foreground" aria-label="Загрузка изображения" /></div>;
  }

  return (
    <>
      <div className={cx("group relative", className)}>
        {/* The source is an authenticated, short-lived object URL. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <button type="button" className="block w-full cursor-zoom-in overflow-hidden rounded-lg text-left" aria-label={`Открыть изображение: ${label}`} onClick={() => setViewerOpen(true)}>
          <img src={objectUrl} alt={label} className="h-auto max-h-[70dvh] w-full object-contain" />
        </button>
        <div className="absolute right-1.5 top-1.5 opacity-60 transition-opacity hover:opacity-100 focus-within:opacity-100">
          <Button type="button" size="icon-xs" variant="secondary" aria-label="Скачать изображение" onClick={() => void download()}><Download aria-hidden="true" /></Button>
        </div>
      </div>
      <ImageViewerDialog label={label} onDownload={() => void download()} onOpenChange={setViewerOpen} open={viewerOpen} src={objectUrl} />
    </>
  );
}
