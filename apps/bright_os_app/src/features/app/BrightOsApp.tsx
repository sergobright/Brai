"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { BookOpen, Crown, Info, Settings } from "lucide-react";
import { APP_ENVIRONMENT, APP_OTA_CHANNEL, APP_PREVIEW_SLOT } from "@/shared/config/runtime";
import { installAndroidBackHandler } from "@/shared/platform/platform";
import type { BrightOtaState } from "@/shared/platform/ota";
import { Button } from "@/shared/ui/button";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { SidebarInset, SidebarProvider } from "@/shared/ui/sidebar";
import type { SectionId } from "./appModel";
import { isPrimarySection, sectionIcon, sectionTitle } from "./appModel";
import { cx } from "./appUtils";
import { AuthPanel, IconButton, MobileContextSheet, ScreenHeader, ThemeButton } from "./chrome/AppChrome";
import { useBrightOsAppState } from "./hooks/useBrightOsAppState";
import { DesktopRail, MainDock, MobileMenuButton, MobileProfileDrawer } from "./navigation/AppNavigation";
import { isMobileNavigationViewport, sectionSwipePageStyle, useLeftEdgeMenuSwipe } from "./navigation/useSectionSwipeNavigation";
import { ActionsSection } from "./sections/actions/ActionsSection";
import { ActionsInfoPanel } from "./sections/actions/ActionsInfoPanel";
import { ArchiveSection } from "./sections/actions/ArchiveSection";
import { EvilEyeSection } from "./sections/EvilEyeSection";
import { FocusBackground, FocusContextPanelSheet, FocusSection } from "./sections/focus/FocusSection";
import { InboxSection } from "./sections/inbox/InboxSection";
import { SettingsSection } from "./sections/settings/SettingsSection";

const SECTION_PAGE_INSET_CLASS = "grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] pb-11 pl-7 pr-0 pt-3.5 max-[860px]:px-3.5 max-[860px]:pb-7 max-[860px]:pt-[var(--mobile-top-padding)]";

export function BrightOsApp({ initialSection = "actions" }: { initialSection?: SectionId }) {
  const app = useBrightOsAppState(initialSection);
  const mobileViewport = useMountedMobileNavigationViewport();
  const sectionRef = useRef(app.section);
  const selectSectionRef = useRef(app.selectSection);
  const adjacentSection = app.swipeNavigation.visual?.to;
  const apkBlocked = isDevPreviewApkIncompatible(app.otaState);
  const mobileMenuSwipe = useLeftEdgeMenuSwipe(
    () => app.setMobileMenuOpen(true),
    isPrimarySection(app.section) && !app.mobileMenuOpen && !app.mobileContextPanel && !app.actionOverlayOpen,
  );

  useEffect(() => {
    sectionRef.current = app.section;
    selectSectionRef.current = app.selectSection;
  }, [app.section, app.selectSection]);

  useEffect(() => installAndroidBackHandler(() => {
    if (window.history.state?.brightMobileMenu || window.history.state?.brightMobileSheet || window.history.state?.brightActivityEditor || window.history.state?.brightMobileActionCreate || window.history.state?.brightInboxEditor || window.history.state?.brightMobileInboxCreate) return false;
    if (sectionRef.current === "actions") return false;
    if (window.history.state?.brightOsSection === sectionRef.current) {
      window.history.back();
    } else {
      selectSectionRef.current("actions");
    }
    return true;
  }), []);

  function renderSectionScreen(screenSection: SectionId, isActivePage: boolean) {
    return (
      <>
        <ScreenHeader
          title={sectionTitle(screenSection)}
          icon={sectionIcon(screenSection)}
          syncStatus={app.displaySyncStatus}
          pendingCount={app.totalPendingCount}
          leading={isPrimarySection(screenSection) ? <MobileMenuButton onClick={() => app.setMobileMenuOpen(true)} /> : null}
          trailing={
            screenSection === "actions" && mobileViewport ? (
              <IconButton icon={Info} label="Информация о действиях" active={app.actionsInfoActive} onClick={app.toggleActionsInfoPanel} />
            ) : screenSection === "inbox" && mobileViewport ? (
              <IconButton icon={Info} label="Информация о входящих" active={app.inboxInfoActive} onClick={app.toggleInboxInfoPanel} />
            ) : screenSection === "focus" ? (
              <>
                <IconButton icon={Crown} label="Цели фокусировки" active={app.focusGoalActive} onClick={() => app.toggleFocusContextPanel("goal")} />
                <IconButton icon={BookOpen} label="История фокуса" active={app.focusHistoryActive} onClick={() => app.toggleFocusContextPanel("history")} />
              </>
            ) : screenSection === "archive" ? (
              <IconButton icon={Settings} label="Назад к настройкам" onClick={app.openSettingsPage} />
            ) : screenSection === "settings" ? (
              <ThemeButton theme={app.theme} onTheme={app.setTheme} />
            ) : null
          }
        />
        {app.displaySyncStatus === "auth_required" ? (
          <AuthPanel busy={app.busy} onLogin={app.onLogin} />
        ) : screenSection === "actions" ? (
          <ActionsSection
            state={app.actions}
            localSnapshotReady={app.localSnapshotReady}
            autoFocusAddInput={isActivePage}
            onCreate={app.onCreateAction}
            onUpdateTitle={app.onUpdateActionTitle}
            onAutosaveDetails={app.onAutosaveActionDetails}
            onSetStatus={app.onSetActionStatus}
            onDelete={app.onDeleteAction}
            onReorder={app.onReorderActions}
            onMobileOverlayChange={app.setActionOverlayOpen}
          />
        ) : screenSection === "inbox" ? (
          <InboxSection
            state={app.inbox}
            localSnapshotReady={app.localSnapshotReady}
            autoFocusAddInput={isActivePage}
            onCreate={app.onCreateInboxItem}
            onUpdateTitle={app.onUpdateInboxTitle}
            onAutosaveDetails={app.onAutosaveInboxDetails}
            onDelete={app.onDeleteInboxItem}
            onMobileOverlayChange={app.setActionOverlayOpen}
          />
        ) : screenSection === "archive" ? (
          <ArchiveSection state={app.actions} localSnapshotReady={app.localSnapshotReady} onRestore={app.onRestoreAction} />
        ) : screenSection === "focus" ? (
          <FocusSection
            state={app.timer}
            history={app.history}
            goal={app.goal}
            todayKey={app.todayKey}
            contextPanel={app.focusContextPanel}
            active={app.active}
            busy={app.timerBusy}
            background={app.focusBackground}
            onStart={app.onStart}
            onStop={app.onStop}
            onEditSession={app.onEditFocusSession}
            onBackground={app.setFocusBackground}
          />
        ) : screenSection === "evil-eye" ? (
          <EvilEyeSection />
        ) : screenSection === "settings" ? (
          <SettingsSection
            otaState={app.otaState}
            otaCheckedAt={app.otaCheckedAt}
            otaRefreshing={app.otaRefreshing}
            bundlePublishedAt={app.bundlePublishedAt}
            onRefreshOta={app.refreshOtaStateOnce}
          />
        ) : null}
      </>
    );
  }

  if (apkBlocked) {
    return <ApkCompatibilityBlocker otaState={app.otaState} refreshing={app.otaRefreshing} onRefresh={app.refreshOtaStateOnce} />;
  }

  return (
    <SidebarProvider
      open={app.desktopRailExpanded}
      onOpenChange={app.setDesktopRailExpanded}
      className={cx(
        "app-shell h-dvh min-h-0 overflow-hidden [--sticky-top-offset:0px] max-[860px]:grid max-[860px]:grid-rows-[minmax(0,1fr)_auto] max-[860px]:[--mobile-top-padding:env(safe-area-inset-top)]",
        app.desktopRailExpanded && "is-rail-expanded",
        app.actionOverlayOpen && "has-mobile-action-overlay max-[860px]:pb-0",
        app.mobileMenuOpen && "has-mobile-menu",
      )}
      data-app-shell
    >
      <DesktopRail
        expanded={app.desktopRailExpanded}
        section={app.section}
        onSettings={app.openSettingsPage}
        onArchive={() => app.selectSection("archive")}
        onLogout={app.onLogout}
      />
      <SidebarInset className={cx("main-view m-0 h-full min-h-0 w-full min-w-0 overflow-hidden max-[860px]:overscroll-contain max-[860px]:[touch-action:pan-y]", app.swipeNavigation.visual && "is-section-swiping")} {...mobileMenuSwipe.handlers}>
        {app.section === "focus" ? <FocusBackground active={app.active} mode={app.focusBackground} /> : null}
        <ScrollArea scrollbar={false} className="main-scroll relative z-[1] h-full [&>[data-slot=scroll-area-viewport]>div]:h-full max-[860px]:[&>[data-slot=scroll-area-viewport]]:overscroll-contain max-[860px]:[&>[data-slot=scroll-area-viewport]]:[touch-action:pan-y]">
          <div className="section-swipe-stage relative m-0 h-full min-h-0 w-full overflow-x-hidden overflow-y-visible">
            <section
              className={cx("section-page section-page-current relative z-[1] min-w-0 [backface-visibility:hidden]", SECTION_PAGE_INSET_CLASS, app.swipeNavigation.visual && "will-change-transform")}
              data-section-page={app.section}
              style={sectionSwipePageStyle(app.swipeNavigation.visual, "current")}
            >
              {renderSectionScreen(app.section, true)}
            </section>
            {adjacentSection && adjacentSection !== app.section ? (
              <section
                className={cx("section-page section-page-adjacent pointer-events-none absolute inset-0 z-0 min-w-0 [backface-visibility:hidden]", SECTION_PAGE_INSET_CLASS, app.swipeNavigation.visual && "will-change-transform")}
                data-section-page={adjacentSection}
                aria-hidden="true"
                style={sectionSwipePageStyle(app.swipeNavigation.visual, "adjacent")}
              >
                {renderSectionScreen(adjacentSection, false)}
              </section>
            ) : null}
          </div>
        </ScrollArea>
      </SidebarInset>
      <MainDock
        section={app.section}
        hidden={app.actionOverlayOpen || app.mobileContextPanel != null}
        onSection={app.selectSection}
        swipeHandlers={app.swipeNavigation.handlers}
      />
      {app.mobileMenuOpen && isPrimarySection(app.section) ? (
        <MobileProfileDrawer
          section={app.section}
          onClose={() => app.setMobileMenuOpen(false)}
          onSettings={app.openSettingsPage}
          onArchive={() => app.selectSection("archive")}
          onLogout={app.onLogout}
        />
      ) : null}
      {app.mobileContextPanel === "actions-info" && app.section === "actions" ? (
        <MobileContextSheet label="Информация о действиях" onClose={() => app.setMobileContextPanel(null)} onCloseStart={app.markMobileContextPanelClosing}>
          <ActionsInfoPanel mobile />
        </MobileContextSheet>
      ) : null}
      {app.mobileContextPanel === "inbox-info" && app.section === "inbox" ? (
        <MobileContextSheet label="Информация о входящих" onClose={() => app.setMobileContextPanel(null)} onCloseStart={app.markMobileContextPanelClosing}>
          <ActionsInfoPanel label="Информация о входящих" mobile />
        </MobileContextSheet>
      ) : null}
      {app.mobileContextPanel === "focus-goal" && app.section === "focus" ? (
        <FocusContextPanelSheet panel="goal" history={app.history} goal={app.goal} todayKey={app.todayKey} onClose={() => app.setMobileContextPanel(null)} onCloseStart={app.markMobileContextPanelClosing} onEditSession={app.onEditFocusSession} />
      ) : null}
      {app.mobileContextPanel === "focus-history" && app.section === "focus" ? (
        <FocusContextPanelSheet panel="history" history={app.history} goal={app.goal} todayKey={app.todayKey} onClose={() => app.setMobileContextPanel(null)} onCloseStart={app.markMobileContextPanelClosing} onEditSession={app.onEditFocusSession} />
      ) : null}
    </SidebarProvider>
  );
}

function useMountedMobileNavigationViewport(): boolean {
  return useSyncExternalStore(
    subscribeMobileNavigationViewport,
    isMobileNavigationViewport,
    () => false,
  );
}

function subscribeMobileNavigationViewport(onStoreChange: () => void) {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => undefined;
  const query = window.matchMedia("(max-width: 860px)");
  query.addEventListener("change", onStoreChange);
  return () => query.removeEventListener("change", onStoreChange);
}

function isDevPreviewApkIncompatible(otaState: BrightOtaState | null): boolean {
  if (otaState?.lastCheckStatus !== "incompatible") return false;
  return (otaState.nativeEnvironment || APP_ENVIRONMENT) !== "prod";
}

function ApkCompatibilityBlocker({
  otaState,
  refreshing,
  onRefresh,
}: {
  otaState: BrightOtaState | null;
  refreshing: boolean;
  onRefresh: () => Promise<void>;
}) {
  const releaseUrl = apkReleaseUrl(otaState);
  const environment = otaState?.nativeEnvironment || APP_ENVIRONMENT;
  const rows = [
    { label: "Окружение", value: environment === "dev" ? "Dev" : APP_PREVIEW_SLOT || otaState?.nativePreviewSlot || environment },
    { label: "APK", value: apkLabel(otaState) },
    { label: "Web", value: otaState?.activeBundleVersion || "неизвестно" },
    { label: "Fallback", value: otaState?.fallbackBundleVersion || "неизвестно" },
  ];

  return (
    <main className="grid min-h-dvh place-items-center bg-background px-4 py-8 text-foreground">
      <section className="grid w-full max-w-[520px] gap-5 rounded-lg border border-destructive/35 bg-card p-5 shadow-sm" aria-label="APK устарел">
        <div className="grid gap-1.5">
          <p className="m-0 text-xs font-semibold uppercase text-destructive">Нужен новый APK</p>
          <h1 className="m-0 text-2xl leading-tight">Установленный APK не подходит для этой версии</h1>
          <p className="m-0 text-sm leading-6 text-muted-foreground">
            Эта Dev/Preview сборка требует другой Android shell. Установи свежий APK и запусти проверку снова.
          </p>
        </div>
        <dl className="m-0 grid gap-2.5">
          {rows.map((row) => (
            <div key={row.label} className="flex items-baseline justify-between gap-3 max-[460px]:grid max-[460px]:gap-0.5">
              <dt className="text-xs font-normal uppercase text-muted-foreground">{row.label}</dt>
              <dd className="m-0 max-w-[70%] [overflow-wrap:anywhere] text-right text-sm tabular-nums max-[460px]:max-w-full max-[460px]:text-left">{row.value}</dd>
            </div>
          ))}
        </dl>
        <div className="flex flex-wrap gap-2.5">
          <Button type="button" disabled={refreshing} onClick={() => void onRefresh()}>
            {refreshing ? "Проверяем..." : "Проверить снова"}
          </Button>
          <Button asChild type="button" variant="secondary">
            <a href={releaseUrl}>Открыть APK-релизы</a>
          </Button>
        </div>
      </section>
    </main>
  );
}

function apkLabel(otaState: BrightOtaState | null): string {
  const version = otaState?.nativeVersionName || "неизвестно";
  const build = otaState?.nativeBuild && otaState.nativeBuild !== version ? `+${otaState.nativeBuild}` : "";
  const code = otaState?.nativeVersionCode ? ` (${otaState.nativeVersionCode})` : "";
  return `${version}${build}${code}`;
}

function apkReleaseUrl(otaState: BrightOtaState | null): string {
  const channel = otaState?.nativeOtaChannel || APP_OTA_CHANNEL;
  const host = channel.split("/")[0];
  return host ? `https://${host}/releases/` : "/releases/";
}
