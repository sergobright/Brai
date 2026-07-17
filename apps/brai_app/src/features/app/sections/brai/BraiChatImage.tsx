"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Loader2, RefreshCw, X } from "lucide-react";
import { Dialog } from "@base-ui/react/dialog";
import { installAndroidBackHandler } from "@/shared/platform/platform";
import { Button } from "@/shared/ui/button";
import { cx } from "../../appUtils";
import { useMobileSheetDrag } from "../../hooks/useMobileSheetDrag";

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
  const closeViewer = useCallback(() => setViewerOpen(false), []);
  const {
    backdropRef,
    backdropStyle,
    closeWithAnimation,
    gestureRef,
    resetOpen,
    sheetDragHandlers,
    sheetRef,
    sheetStyle,
  } = useMobileSheetDrag({ onClose: closeViewer });

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

  useEffect(() => {
    if (!viewerOpen) return;
    resetOpen();
    return installAndroidBackHandler(() => {
      closeWithAnimation();
      return true;
    });
  }, [closeWithAnimation, resetOpen, viewerOpen]);

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
      <Dialog.Root open={viewerOpen} onOpenChange={setViewerOpen}>
        <Dialog.Portal>
          <Dialog.Backdrop ref={backdropRef} className="fixed inset-0 z-[180] bg-background/95 backdrop-blur-sm" style={backdropStyle} />
          <Dialog.Viewport ref={gestureRef} className="fixed inset-0 z-[181] grid place-items-center px-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] pt-[calc(env(safe-area-inset-top)+0.75rem)]" {...sheetDragHandlers}>
            <Dialog.Popup ref={sheetRef} className="grid h-full w-full max-w-5xl grid-rows-[auto_minmax(0,1fr)] outline-none" style={sheetStyle}>
              <Dialog.Title className="sr-only">{label}</Dialog.Title>
              <div className="flex justify-end gap-2" data-mobile-sheet-no-drag>
                <Button type="button" size="sm" variant="secondary" onClick={() => void download()}><Download aria-hidden="true" />Скачать</Button>
                <Button type="button" size="icon-sm" variant="secondary" aria-label="Закрыть просмотр" onClick={closeViewer}><X aria-hidden="true" /></Button>
              </div>
              <div className="grid min-h-0 place-items-center overflow-auto p-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={objectUrl} alt={label} className="max-h-full max-w-full object-contain" />
              </div>
            </Dialog.Popup>
          </Dialog.Viewport>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
