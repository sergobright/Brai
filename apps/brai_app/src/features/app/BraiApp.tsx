"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { BookOpen, Crown, Info, Settings } from "lucide-react";
import { ensureBraiCmdAccess, openBraiCmdSettings, setBraiCmdOverlayEnabled, setBraiCmdQueuePausedMode, setBraiCmdVoiceOnlyMode } from "@/shared/platform/braiCmd";
import { installAndroidBackHandler, isNativeShell, platformName } from "@/shared/platform/platform";
import { getBraiLocalStorageItem, removeBraiLocalStorageItem, setBraiLocalStorageItem } from "@/shared/storage/localStorageKeys";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { SidebarInset, SidebarProvider } from "@/shared/ui/sidebar";
import { OnboardingFlow, shouldShowOnboarding } from "@/features/onboarding/OnboardingFlow";
import { AppStartupSplash } from "./AppStartupSplash";
import type { SectionId } from "./appModel";
import { isPrimarySection, sectionIcon, sectionTitle } from "./appModel";
import { cx } from "./appUtils";
import { AuthPanel, IconButton, MobileContextSheet, ScreenHeader, ThemeButton } from "./chrome/AppChrome";
import { useBraiAppState } from "./hooks/useBraiAppState";
import { DesktopRail, MainDock, MobileDockOverflowButton, MobileDockOverflowSheet, MobileMenuButton, MobileProfileDrawer } from "./navigation/AppNavigation";
import { isMobileNavigationViewport, sectionSwipePageStyle, useLeftEdgeMenuSwipe } from "./navigation/useSectionSwipeNavigation";
import { ActionsSection } from "./sections/actions/ActionsSection";
import { ActionsInfoPanel } from "./sections/actions/ActionsInfoPanel";
import { ArchiveSection } from "./sections/actions/ArchiveSection";
import { BraiCmdSection } from "./sections/brai-cmd/BraiCmdSection";
import { EvilEyeSection } from "./sections/EvilEyeSection";
import { EngineSection } from "./sections/engine/EngineSection";
import { FactorySection } from "./sections/factory/FactorySection";
import { FocusBackground, FocusContextPanelSheet, FocusSection } from "./sections/focus/FocusSection";
import { InboxSection } from "./sections/inbox/InboxSection";
import { SettingsSection } from "./sections/settings/SettingsSection";
import type { MobileCreateDraft } from "./sections/MobileCreateComposer";

const SECTION_PAGE_INSET_CLASS = "grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] pb-11 pl-7 pr-0 pt-3.5 max-[860px]:px-3.5 max-[860px]:pb-7 max-[860px]:pt-[var(--mobile-top-padding)]";
const EMPTY_MOBILE_CREATE_DRAFT: MobileCreateDraft = { title: "", descriptionMd: "" };
const ACTIONS_MOBILE_CREATE_DRAFT_STORAGE_KEY = "brai_actions_mobile_create_draft";
const INBOX_MOBILE_CREATE_DRAFT_STORAGE_KEY = "brai_inbox_mobile_create_draft";

export function BraiApp({ initialSection = "actions" }: { initialSection?: SectionId }) {
  const app = useBraiAppState(initialSection);
  const nativeAndroid = useMountedNativeAndroid();
  const [mobileDockMenu, setMobileDockMenu] = useState<"left" | "right" | null>(null);
  const [startupIntroComplete, setStartupIntroComplete] = useState(false);
  const [onboardingStartupActive, setOnboardingStartupActive] = useState(true);
  const [onboardingVisible, setOnboardingVisible] = useState(() => process.env.NODE_ENV === "test" ? shouldShowOnboarding(false) : true);
  const onboardingActive = nativeAndroid && onboardingVisible;
  const dockOverflowOpen = mobileDockMenu != null;
  const [actionsMobileCreateDraft, setActionsMobileCreateDraft] = useStoredMobileCreateDraft(ACTIONS_MOBILE_CREATE_DRAFT_STORAGE_KEY);
  const [inboxMobileCreateDraft, setInboxMobileCreateDraft] = useStoredMobileCreateDraft(INBOX_MOBILE_CREATE_DRAFT_STORAGE_KEY);
  const mobileViewport = useMountedMobileNavigationViewport();
  const sectionRef = useRef(app.section);
  const selectSectionRef = useRef(app.selectSection);
  const adjacentSection = app.swipeNavigation.visual?.to;
  const startupReady = app.localSnapshotReady || app.displaySyncStatus === "auth_required" || app.displaySyncStatus === "offline" || app.displaySyncStatus === "sync_failed";
  const handleStartupIntroComplete = useCallback(() => setStartupIntroComplete(true), []);
  const mobileMenuSwipe = useLeftEdgeMenuSwipe(
    () => setMobileDockMenu("left"),
    !app.mobileMenuOpen && !mobileDockMenu && !app.mobileContextPanel && !app.actionOverlayOpen,
  );

  function openMobileMenu() {
    app.setMobileMenuOpen(true);
  }

  function openBraiCmd() {
    void openBraiCmdSettings().then((opened) => {
      if (!opened) app.selectSection("brai-cmd");
    });
  }

  async function openNativeBraiCmdSettings() {
    return await openBraiCmdSettings();
  }

  useEffect(() => {
    sectionRef.current = app.section;
    selectSectionRef.current = app.selectSection;
  }, [app.section, app.selectSection]);

  useEffect(() => {
    if (!nativeAndroid) return;
    const timeout = window.setTimeout(() => {
      setOnboardingVisible(shouldShowOnboarding(startupReady && app.displaySyncStatus === "auth_required"));
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [app.displaySyncStatus, nativeAndroid, startupReady]);

  useEffect(() => {
    document.documentElement.dataset.theme = onboardingActive ? "dark" : app.theme;
  }, [app.theme, onboardingActive]);

  useEffect(() => {
    if (!nativeAndroid) return;
    if (app.displaySyncStatus === "auth_required") {
      void setBraiCmdVoiceOnlyMode(true);
      return;
    }
    if (
      onboardingVisible ||
      !app.localSnapshotReady ||
      app.displaySyncStatus === "connecting"
    ) return;
    void Promise.all([
      ensureBraiCmdAccess(app.authDisplayName),
      setBraiCmdOverlayEnabled(true),
      setBraiCmdVoiceOnlyMode(false),
      setBraiCmdQueuePausedMode(false),
    ]);
  }, [app.authDisplayName, app.displaySyncStatus, app.localSnapshotReady, nativeAndroid, onboardingVisible]);

  useEffect(() => installAndroidBackHandler(() => {
    if (window.history.state?.braiMobileMenu || window.history.state?.braiMobileDockMenu || window.history.state?.braiMobileSheet || window.history.state?.braiActivityEditor || window.history.state?.braiMobileActionCreate || window.history.state?.braiInboxEditor || window.history.state?.braiMobileInboxCreate || window.history.state?.braiFactoryLog) return false;
    if (sectionRef.current === "actions") return false;
    if (window.history.state?.braiSection === sectionRef.current) {
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
          leading={isPrimarySection(screenSection) ? <MobileMenuButton onClick={openMobileMenu} /> : null}
          trailing={
            screenSection === "actions" && mobileViewport ? (
              <IconButton icon={Info} label="Информация о действиях" active={app.actionsInfoActive} onClick={app.toggleActionsInfoPanel} />
            ) : screenSection === "inbox" && mobileViewport ? (
              <IconButton icon={Info} label="Информация о входящих" active={app.inboxInfoActive} onClick={app.toggleInboxInfoPanel} />
            ) : screenSection === "focus" ? (
              <>
                <IconButton icon={Crown} label="Цели фокусировки" active={app.focusGoalActive} onClick={() => app.toggleFocusContextPanel("goal")} />
                <IconButton icon={BookOpen} label="История фокуса" active={app.focusHistoryActive} className="min-[861px]:mr-5 max-[860px]:mr-1.5" onClick={() => app.toggleFocusContextPanel("history")} />
              </>
            ) : screenSection === "archive" ? (
              <IconButton icon={Settings} label="Назад к настройкам" onClick={app.openSettingsPage} />
            ) : screenSection === "settings" ? (
              <ThemeButton theme={app.theme} onTheme={app.setTheme} />
            ) : null
          }
        />
        {app.displaySyncStatus === "auth_required" ? (
          <AuthPanel
            busy={app.busy}
            mode={app.authMode}
            onLogin={app.onLogin}
            onRequestOtp={app.onRequestOtp}
            onVerifyOtp={app.onVerifyOtp}
          />
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
            mobileCreateDraft={actionsMobileCreateDraft}
            onMobileCreateDraftChange={setActionsMobileCreateDraft}
            dockOverflowOpen={dockOverflowOpen}
            onMobileOverlayChange={app.setActionOverlayOpen}
            activeActivityId={app.timer.active_activity_id ?? null}
            activeActivityElapsedSeconds={app.timer.active_interval_elapsed_seconds ?? 0}
            onStartActionFocus={app.onStartActionFocus}
            onStopActionFocus={app.onStopActionFocus}
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
            mobileCreateDraft={inboxMobileCreateDraft}
            onMobileCreateDraftChange={setInboxMobileCreateDraft}
            dockOverflowOpen={dockOverflowOpen}
            onMobileOverlayChange={app.setActionOverlayOpen}
          />
        ) : screenSection === "archive" ? (
          <ArchiveSection state={app.actions} localSnapshotReady={app.localSnapshotReady} onRestore={app.onRestoreAction} />
        ) : screenSection === "factory" ? (
          <FactorySection onMobileOverlayChange={app.setActionOverlayOpen} />
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
            onDeleteSession={app.onDeleteFocusSession}
            onEditInterval={app.onEditFocusInterval}
            onEditSession={app.onEditFocusSession}
            onBackground={app.setFocusBackground}
          />
        ) : screenSection === "evil-eye" ? (
          <EvilEyeSection />
        ) : screenSection === "engine" ? (
          <EngineSection
            appVersionState={app.versionState}
            otaState={app.otaState}
            otaCheckedAt={app.otaCheckedAt}
            otaRefreshing={app.otaRefreshing}
            bundlePublishedAt={app.bundlePublishedAt}
            versionCheckedAt={app.versionCheckedAt}
            versionError={app.versionError}
            versionRefreshing={app.versionRefreshing}
            onRefreshEngine={app.refreshEngineOnce}
          />
        ) : screenSection === "settings" ? (
          <SettingsSection />
        ) : screenSection === "brai-cmd" ? (
          <BraiCmdSection />
        ) : null}
      </>
    );
  }

  return (
    <>
      {onboardingActive ? (
        <OnboardingFlow
          authRequired={startupReady && app.displaySyncStatus === "auth_required"}
          authMode={app.authMode}
          busy={app.busy}
          onDone={() => setOnboardingVisible(false)}
          onLogin={app.onLogin}
          onOpenNativeCmdSettings={openNativeBraiCmdSettings}
          onRequestOtp={app.onRequestOtp}
          onStartupScreenChange={setOnboardingStartupActive}
          onVerifyOtp={app.onVerifyOtp}
          startupIntroComplete={startupIntroComplete}
        />
      ) : (
        <SidebarProvider
      open={false}
      className={cx(
        "app-shell h-dvh min-h-0 overflow-hidden [--sticky-top-offset:0px] max-[860px]:grid max-[860px]:grid-rows-[minmax(0,1fr)_auto] max-[860px]:[--mobile-top-padding:env(safe-area-inset-top)]",
        app.actionOverlayOpen && "has-mobile-action-overlay max-[860px]:pb-0",
        app.mobileMenuOpen && "has-mobile-menu",
      )}
      data-app-shell
    >
      <DesktopRail
        section={app.section}
        appVersionState={app.versionState}
        otaRefreshing={app.otaRefreshing}
        otaState={app.otaState}
        pendingCount={app.totalPendingCount}
        versionError={app.versionError}
        versionRefreshing={app.versionRefreshing}
        syncStatus={app.displaySyncStatus}
        onSettings={app.openSettingsPage}
        onBraiCmd={openBraiCmd}
        onEngine={() => app.selectSection("engine")}
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
        timer={app.timer}
      />
      <MobileDockOverflowButton
        side="left"
        hidden={app.mobileMenuOpen || mobileDockMenu === "left" || app.actionOverlayOpen}
        onClick={() => setMobileDockMenu("left")}
      />
      <MobileDockOverflowButton
        side="right"
        open={mobileDockMenu === "right"}
        hidden={app.mobileMenuOpen || mobileDockMenu === "left" || app.actionOverlayOpen}
        onClick={() => setMobileDockMenu((current) => current === "right" ? null : "right")}
      />
      {app.mobileMenuOpen ? (
        <MobileProfileDrawer
          onClose={() => app.setMobileMenuOpen(false)}
        />
      ) : null}
      {mobileDockMenu ? (
        <MobileDockOverflowSheet
          side={mobileDockMenu}
          section={app.section}
          appVersionState={app.versionState}
          otaRefreshing={app.otaRefreshing}
          otaState={app.otaState}
          versionError={app.versionError}
          versionRefreshing={app.versionRefreshing}
          onClose={() => setMobileDockMenu(null)}
          onSettings={app.openSettingsPage}
          onBraiCmd={openBraiCmd}
          onEngine={() => app.selectSection("engine")}
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
        <FocusContextPanelSheet panel="goal" history={app.history} goal={app.goal} todayKey={app.todayKey} onClose={() => app.setMobileContextPanel(null)} onCloseStart={app.markMobileContextPanelClosing} onDeleteSession={app.onDeleteFocusSession} onEditInterval={app.onEditFocusInterval} onEditSession={app.onEditFocusSession} />
      ) : null}
      {app.mobileContextPanel === "focus-history" && app.section === "focus" ? (
        <FocusContextPanelSheet panel="history" history={app.history} goal={app.goal} todayKey={app.todayKey} onClose={() => app.setMobileContextPanel(null)} onCloseStart={app.markMobileContextPanelClosing} onDeleteSession={app.onDeleteFocusSession} onEditInterval={app.onEditFocusInterval} onEditSession={app.onEditFocusSession} />
      ) : null}
        </SidebarProvider>
      )}
      <AppStartupSplash
        ready={startupReady}
        persist={onboardingActive && onboardingStartupActive}
        onIntroComplete={handleStartupIntroComplete}
      />
    </>
  );
}

function useMountedMobileNavigationViewport(): boolean {
  return useSyncExternalStore(
    subscribeMobileNavigationViewport,
    isMobileNavigationViewport,
    () => false,
  );
}

function useMountedNativeAndroid(): boolean {
  return useSyncExternalStore(
    subscribeNativeAndroid,
    isNativeAndroid,
    () => false,
  );
}

function subscribeNativeAndroid() {
  return () => undefined;
}

function isNativeAndroid(): boolean {
  return isNativeShell() && platformName() === "android";
}

function subscribeMobileNavigationViewport(onStoreChange: () => void) {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => undefined;
  const query = window.matchMedia("(max-width: 860px)");
  query.addEventListener("change", onStoreChange);
  return () => query.removeEventListener("change", onStoreChange);
}

function useStoredMobileCreateDraft(storageKey: string) {
  const [draft, setDraftState] = useState<MobileCreateDraft>(() => loadMobileCreateDraft(storageKey));
  const setDraft = useCallback((nextDraft: MobileCreateDraft) => {
    setDraftState(nextDraft);
    saveMobileCreateDraft(storageKey, nextDraft);
  }, [storageKey]);
  return [draft, setDraft] as const;
}

function loadMobileCreateDraft(storageKey: string): MobileCreateDraft {
  if (typeof window === "undefined") return EMPTY_MOBILE_CREATE_DRAFT;
  try {
    const raw = getBraiLocalStorageItem(storageKey);
    if (!raw) return EMPTY_MOBILE_CREATE_DRAFT;
    const parsed = JSON.parse(raw) as Partial<MobileCreateDraft>;
    return {
      title: typeof parsed.title === "string" ? parsed.title : "",
      descriptionMd: typeof parsed.descriptionMd === "string" ? parsed.descriptionMd : "",
    };
  } catch {
    return EMPTY_MOBILE_CREATE_DRAFT;
  }
}

function saveMobileCreateDraft(storageKey: string, draft: MobileCreateDraft) {
  if (typeof window === "undefined") return;
  try {
    if (!draft.title.trim() && !draft.descriptionMd.trim()) {
      removeBraiLocalStorageItem(storageKey);
      return;
    }
    setBraiLocalStorageItem(storageKey, JSON.stringify(draft));
  } catch {
    // localStorage can be unavailable in constrained WebViews.
  }
}
