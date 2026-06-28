import { Archive, Eye, Inbox as InboxIcon, Settings, SquareTerminal, Timer, type LucideIcon } from "lucide-react";

export type SectionId = "actions" | "inbox" | "focus" | "archive" | "settings" | "evil-eye";
export type PrimarySectionId = "actions" | "inbox" | "focus";
export type FocusContextPanel = "none" | "goal" | "history";
export type FocusBackgroundMode = "galaxy" | "evil-eye";
export type MobileContextPanel = "actions-info" | "inbox-info" | "focus-goal" | "focus-history";
export type ThemeMode = "light" | "dark";
export type Tone = "ok" | "warn" | "bad" | "muted";
export const SECTION_GRID_CLASS = "grid gap-3.5";
export const navItems: Array<{ id: PrimarySectionId; label: string; icon: LucideIcon; group: "Platform" | "Time"; }> = [
  { id: "actions", label: "Действия", icon: SquareTerminal, group: "Platform" },
  { id: "inbox", label: "Входящие", icon: InboxIcon, group: "Platform" },
  { id: "focus", label: "Фокус", icon: Timer, group: "Time" },
];
export const FOCUS_CONTEXT_PANEL_STORAGE_KEY = "bright_os_focus_context_panel";
export const FOCUS_BACKGROUND_STORAGE_KEY = "bright_os_focus_background";

export function sectionTitle(section: SectionId): string {
  if (section === "archive") return "Архив";
  if (section === "settings") return "Настройки";
  if (section === "evil-eye") return "Evil Eye";
  if (section === "inbox") return "Входящие";
  return navItems.find((item) => item.id === section)?.label ?? "Фокус";
}

export function sectionIcon(section: SectionId): LucideIcon {
  if (section === "archive") return Archive;
  if (section === "settings") return Settings;
  if (section === "evil-eye") return Eye;
  return navItems.find((item) => item.id === section)?.icon ?? Timer;
}

export function sectionFromLocation(): SectionId {
  if (typeof window === "undefined") return "actions";
  if (isSectionId(window.history.state?.brightOsSection)) return window.history.state.brightOsSection;
  const path = window.location.pathname.replace(/\/+$/, "");
  if (path === "/inbox") return "inbox";
  if (path === "/focus") return "focus";
  if (path === "/evil-eye") return "evil-eye";
  return "actions";
}

export function syncSectionUrl(section: SectionId): void {
  if (typeof window === "undefined") return;
  const nextPath = section === "inbox" ? "/inbox" : section === "focus" ? "/focus" : section === "evil-eye" ? "/evil-eye" : "/";
  if (window.location.pathname === nextPath && sectionFromLocation() === section) return;
  window.history.pushState({ brightOsSection: section }, "", nextPath);
}

export function isPrimarySection(section: SectionId): section is PrimarySectionId {
  return section === "actions" || section === "inbox" || section === "focus";
}

export function navHref(section: PrimarySectionId): string {
  if (section === "inbox") return "/inbox";
  return section === "focus" ? "/focus" : "/";
}

function isSectionId(value: unknown): value is SectionId {
  return value === "actions" || value === "inbox" || value === "focus" || value === "archive" || value === "settings" || value === "evil-eye";
}
