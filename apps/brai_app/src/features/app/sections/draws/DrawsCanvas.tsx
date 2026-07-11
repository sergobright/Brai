"use client";

import { Excalidraw } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";

export function DrawsCanvas({
  initialData,
  name,
  onChange,
  theme,
}: {
  initialData: Record<string, unknown>;
  name: string;
  onChange: (elements: readonly ExcalidrawElement[], appState: AppState, files: BinaryFiles) => void;
  theme: "light" | "dark";
}) {
  return (
    <Excalidraw
      initialData={initialData}
      langCode="ru-RU"
      name={name}
      onChange={onChange}
      theme={theme}
      UIOptions={{
        canvasActions: {
          loadScene: false,
          saveToActiveFile: false,
          toggleTheme: null,
        },
      }}
    />
  );
}
