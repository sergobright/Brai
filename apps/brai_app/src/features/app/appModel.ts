import { Archive, Command, Cpu, Eye, Factory, Inbox as InboxIcon, Settings, SquareTerminal, Timer, type LucideIcon } from "lucide-react";

export type SectionId = "actions" | "inbox" | "focus" | "factory" | "archive" | "settings" | "brai-cmd" | "engine" | "evil-eye";
export type PrimarySectionId = "actions" | "inbox" | "focus" | "factory";
export type FocusContextPanel = "none" | "goal" | "history";
export type FocusBackgroundMode = "galaxy" | "evil-eye";
export type MobileContextPanel = "actions-info" | "inbox-info" | "focus-goal" | "focus-history";
export type ThemeMode = "light" | "dark";
export type Tone = "ok" | "warn" | "bad" | "muted";
export type AuthMode = "email" | "otp";
export const SECTION_GRID_CLASS = "grid gap-3.5";
export const navItems: Array<{ id: PrimarySectionId; label: string; icon: LucideIcon; group: "Platform" | "Time"; }> = [
  { id: "actions", label: "Действия", icon: SquareTerminal, group: "Platform" },
  { id: "inbox", label: "Входящие", icon: InboxIcon, group: "Platform" },
  { id: "focus", label: "Фокус", icon: Timer, group: "Time" },
  { id: "factory", label: "Factory", icon: Factory, group: "Platform" },
];
export const FOCUS_CONTEXT_PANEL_STORAGE_KEY = "brai_focus_context_panel";
export const FOCUS_BACKGROUND_STORAGE_KEY = "brai_focus_background";

export function resolveAuthMode(production: boolean): AuthMode {
  return production ? "otp" : "email";
}

export function sectionTitle(section: SectionId): string {
  if (section === "archive") return "Архив";
  if (section === "settings") return "Настройки";
  if (section === "brai-cmd") return "Brai Cmd";
  if (section === "engine") return "Engine";
  if (section === "evil-eye") return "Evil Eye";
  if (section === "inbox") return "Входящие";
  if (section === "factory") return "Factory";
  return navItems.find((item) => item.id === section)?.label ?? "Фокус";
}

export function sectionIcon(section: SectionId): LucideIcon {
  if (section === "archive") return Archive;
  if (section === "settings") return Settings;
  if (section === "brai-cmd") return Command;
  if (section === "engine") return Cpu;
  if (section === "evil-eye") return Eye;
  return navItems.find((item) => item.id === section)?.icon ?? Timer;
}

export function sectionFromLocation(): SectionId {
  if (typeof window === "undefined") return "actions";
  if (isSectionId(window.history.state?.braiSection)) return window.history.state.braiSection;
  const path = window.location.pathname.replace(/\/+$/, "");
  if (path === "/inbox") return "inbox";
  if (path === "/focus") return "focus";
  if (path === "/factory") return "factory";
  if (path === "/brai-cmd") return "brai-cmd";
  if (path === "/engine") return "engine";
  if (path === "/evil-eye") return "evil-eye";
  return "actions";
}

export function syncSectionUrl(section: SectionId): void {
  if (typeof window === "undefined") return;
  const nextPath = section === "inbox" ? "/inbox" : section === "focus" ? "/focus" : section === "factory" ? "/factory" : section === "brai-cmd" ? "/brai-cmd" : section === "engine" ? "/engine" : section === "evil-eye" ? "/evil-eye" : "/";
  if (window.location.pathname === nextPath && sectionFromLocation() === section) return;
  window.history.pushState({ braiSection: section }, "", nextPath);
}

export function isPrimarySection(section: SectionId): section is PrimarySectionId {
  return section === "actions" || section === "inbox" || section === "focus" || section === "factory";
}

export function navHref(section: PrimarySectionId): string {
  if (section === "inbox") return "/inbox";
  if (section === "factory") return "/factory";
  return section === "focus" ? "/focus" : "/";
}

function isSectionId(value: unknown): value is SectionId {
  return value === "actions" || value === "inbox" || value === "focus" || value === "factory" || value === "archive" || value === "settings" || value === "brai-cmd" || value === "engine" || value === "evil-eye";
}
