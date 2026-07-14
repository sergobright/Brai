"use client";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, BookOpen, Crown, Info, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import type { AuthOnboardingContext } from "@/shared/api/braiApi";
import { beginBraiCmdAccountCredentialMode, getBraiCmdState, listenBraiCmdCredentialRefreshRequired, retryBraiCmdPendingAccountRevocation, retryBraiCmdQueue, setBraiCmdAccessKey, setBraiCmdAuthenticatedMode, setBraiCmdOverlayEnabled, syncBraiCmdProviderCredentials } from "@/shared/platform/braiCmd";
import { useAppVersion } from "@/shared/config/runtime";
import { installAndroidBackHandler, isNativeShell, platformName } from "@/shared/platform/platform";
import { getBraiLocalStorageItem, removeBraiLocalStorageItem, setBraiLocalStorageItem } from "@/shared/storage/localStorageKeys";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { SidebarInset, SidebarProvider } from "@/shared/ui/sidebar";
import { OnboardingFlow, shouldShowOnboarding } from "@/features/onboarding/OnboardingFlow";
import { loadOnboardingState } from "@/features/onboarding/onboardingModel";
import { AuthScreen } from "./AuthScreen";
import { AppStartupSplash } from "./AppStartupSplash";
import { LocalDatabaseBlockedScreen } from "./LocalDatabaseBlockedScreen";
import type { SectionId } from "./appModel";
import { isPrimarySection, sectionIcon, sectionTitle } from "./appModel";
import { braiCmdBootstrapRetryDelay } from "./braiCmdBootstrap.model";
import { cx } from "./appUtils";
import { IconButton, MobileContextSheet, ScreenHeader, ThemeButton } from "./chrome/AppChrome";
import { useBraiAppState } from "./hooks/useBraiAppState";
import { useActionsWorkspace } from "./hooks/useActionsWorkspace";
import { DesktopRail, MainDock, MobileDockOverflowButton, MobileDockOverflowSheet, MobileMenuButton } from "./navigation/AppNavigation";
import { MobileProfileDrawer, requestMobileProfileDrawerClose } from "./navigation/MobileProfileDrawer";
import { ContextualRail, isContextualRailSection, useContextualRail } from "./navigation/ContextualRail";
import { isMobileNavigationViewport, sectionSwipePageStyle, useLeftEdgeMenuSwipe } from "./navigation/useSectionSwipeNavigation";
import { ActionsSection } from "./sections/actions/ActionsSection";
import { ActionsInfoPanel } from "./sections/actions/ActionsInfoPanel";
import { ArchiveSection } from "./sections/actions/ArchiveSection";
import { ActionsSidebarContent } from "./sections/actions/ActionsSidebarContent";
import { BraiCmdSection } from "./sections/brai-cmd/BraiCmdSection";
import { DrawsSection } from "./sections/draws/DrawsSection";
import { EvilEyeSection } from "./sections/EvilEyeSection";
import { EngineSection } from "./sections/engine/EngineSection";
import { engineSectionView } from "./sections/engine/engineModel";
import { FactorySection } from "./sections/factory/FactorySection";
import { FocusBackground, FocusContextPanelSheet, FocusSection } from "./sections/focus/FocusSection";
import { InboxSection } from "./sections/inbox/InboxSection";
import { ProfileSection } from "./sections/profile/ProfileSection";
import { SettingsSection } from "./sections/settings/SettingsSection";
import type { MobileCreateDraft } from "./sections/MobileCreateComposer";
const SECTION_PAGE_INSET_CLASS = "grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] pb-11 pl-7 pr-0 pt-3.5 max-[860px]:pb-7 max-[860px]:pl-3.5 max-[860px]:pr-0 max-[860px]:pt-[var(--mobile-top-padding)] max-[860px]:[&>.topbar]:pr-3.5";
const FULLSCREEN_SECTION_PAGE_CLASS = "grid h-full min-h-0 grid-rows-[minmax(0,1fr)] p-0";
const EMPTY_MOBILE_CREATE_DRAFT: MobileCreateDraft = { title: "", descriptionMd: "" };
const ACTIONS_MOBILE_CREATE_DRAFT_STORAGE_KEY = "brai_actions_mobile_create_draft";
const INBOX_MOBILE_CREATE_DRAFT_STORAGE_KEY = "brai_inbox_mobile_create_draft";
export function BraiApp({ initialSection = "actions" }: { initialSection?: SectionId }) {
  const app = useBraiAppState(initialSection);
  const appBuild = useAppVersion();
  const engineView = engineSectionView({
    appBuild,
    appVersionState: app.versionState,
    otaRefreshing: app.otaRefreshing,
    otaState: app.otaState,
    versionError: app.versionError,
    versionRefreshing: app.versionRefreshing,
  });
  const engineDownloading = engineView.updateAction === "downloading-web" || engineView.updateAction === "downloading-apk";
  const { authDisplayName, authUser, provisionBraiCmdDeviceToken } = app;
  const authUserId = authUser?.id ?? null;
  const router = useRouter();
  const nativeAndroid = useMountedNativeAndroid();
  const [mobileDockMenu, setMobileDockMenu] = useState<"left" | "right" | null>(null);
  const [startupIntroComplete, setStartupIntroComplete] = useState(false);
  const [onboardingStartupActive, setOnboardingStartupActive] = useState(true);
  const [onboardingVisible, setOnboardingVisible] = useState(() => shouldShowOnboarding(false) || (isNativeAndroid() && shouldKeepStoredLockedOnboarding()));
  const [unauthEngineOpen, setUnauthEngineOpen] = useState(false);
  const [unauthBraiCmdOpen, setUnauthBraiCmdOpen] = useState(false);
  const startupReady = app.localSnapshotReady || app.displaySyncStatus === "auth_required" || app.displaySyncStatus === "offline" || app.displaySyncStatus === "sync_failed";
  const domainMutationsBlocked = !app.localMutationReady && app.displaySyncStatus !== "auth_required";
  const onboardingAuthRequired = startupReady && app.displaySyncStatus === "auth_required";
  const unauthEngineActive = nativeAndroid === true && unauthEngineOpen;
  const unauthBraiCmdActive = nativeAndroid === true && unauthBraiCmdOpen;
  const storedLockedOnboarding = nativeAndroid === true && app.displaySyncStatus === "connecting" && shouldKeepStoredLockedOnboarding();
  const onboardingActive = nativeAndroid === true && (onboardingVisible || onboardingAuthRequired || storedLockedOnboarding) && !unauthEngineActive && !unauthBraiCmdActive;
  const visibleSection = unauthEngineActive ? "engine" : app.section;
  const contextualRail = useContextualRail(visibleSection, app.authUser?.id);
  const [contextualContent, setContextualContent] = useState<{ section: SectionId; content: ReactNode } | null>(null);
  const registerContextualContent = useCallback((section: SectionId, content: ReactNode | null) => {
    setContextualContent((current) => content == null
      ? current?.section === section ? null : current
      : { section, content });
  }, []);
  const registerDrawsRail = useCallback((content: ReactNode | null) => registerContextualContent("draws", content), [registerContextualContent]);
  const registerArchiveRail = useCallback((content: ReactNode | null) => registerContextualContent("archive", content), [registerContextualContent]);
  const activeContextualContent = contextualContent?.section === visibleSection ? contextualContent.content : null;
  const dockOverflowOpen = mobileDockMenu != null;
  const [actionsMobileCreateDraft, setActionsMobileCreateDraft] = useStoredMobileCreateDraft(ACTIONS_MOBILE_CREATE_DRAFT_STORAGE_KEY);
  const [inboxMobileCreateDraft, setInboxMobileCreateDraft] = useStoredMobileCreateDraft(INBOX_MOBILE_CREATE_DRAFT_STORAGE_KEY);
  const mobileViewport = useMountedMobileNavigationViewport();
  const [drawsFullScreen, setDrawsFullScreen] = useState(false);
  const { selectFilter: selectActionsWorkspaceFilter, workspace: actionsWorkspace } = useActionsWorkspace(app.actions, app.inbox, app.relations);
  const drawsFullscreenActive = visibleSection === "draws" && drawsFullScreen;
  const handleDrawsFullscreenChange = useCallback((nextFullScreen: boolean) => {
    setDrawsFullScreen(nextFullScreen);
    if (nextFullScreen) setMobileDockMenu(null);
  }, []);
  const sectionRef = useRef(app.section);
  const selectSectionRef = useRef(app.selectSection);
  const unauthEngineActiveRef = useRef(false);
  const unauthBraiCmdActiveRef = useRef(false);
  const adjacentSection = unauthEngineActive ? null : app.swipeNavigation.visual?.to;
  const handleStartupIntroComplete = useCallback(() => setStartupIntroComplete(true), []);
  const mobileMenuSwipe = useLeftEdgeMenuSwipe(
    () => {
      if (app.section === "actions") app.setMobileMenuOpen(true);
      else setMobileDockMenu("left");
    },
    !app.mobileMenuOpen && !mobileDockMenu && !app.mobileContextPanel && !app.actionOverlayOpen,
  );
  const webAuthRequired = nativeAndroid === false && app.displaySyncStatus === "auth_required";

  function openMobileMenu() {
    app.setMobileMenuOpen(true);
  }

  function openBraiCmd() {
    app.selectSection("brai-cmd");
  }

  async function openNativeBraiCmdSettings() {
    setUnauthBraiCmdOpen(true);
    return true;
  }

  function openUnauthEngine() {
    setUnauthEngineOpen(true);
  }

  function closeUnauthSection() {
    setUnauthEngineOpen(false);
    setUnauthBraiCmdOpen(false);
  }

  async function onOnboardingEmailLogin(email: string, context?: AuthOnboardingContext) {
    await app.onEmailLogin(email, context);
  }

  async function onOnboardingVerifyOtp(email: string, otp: string, context?: AuthOnboardingContext) {
    await app.onVerifyOtp(email, otp, context);
  }

  useEffect(() => {
    sectionRef.current = app.section;
    selectSectionRef.current = app.selectSection;
    unauthEngineActiveRef.current = unauthEngineActive;
    unauthBraiCmdActiveRef.current = unauthBraiCmdActive;
  }, [app.section, app.selectSection, unauthBraiCmdActive, unauthEngineActive]);

  useEffect(() => {
    if (!unauthEngineOpen) return;
    if (nativeAndroid && (!app.localSnapshotReady || onboardingVisible || onboardingAuthRequired)) return;
    const timeout = window.setTimeout(() => setUnauthEngineOpen(false), 0);
    return () => window.clearTimeout(timeout);
  }, [app.localSnapshotReady, nativeAndroid, onboardingAuthRequired, onboardingVisible, unauthEngineOpen]);

  useEffect(() => {
    if (!nativeAndroid) return;
    const timeout = window.setTimeout(() => {
      const shouldBeVisible =
        shouldShowOnboarding(startupReady && app.displaySyncStatus === "auth_required") ||
        (app.displaySyncStatus === "connecting" && shouldKeepStoredLockedOnboarding());
      setOnboardingVisible((current) => current && app.displaySyncStatus === "connecting" ? true : shouldBeVisible);
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [app.displaySyncStatus, nativeAndroid, startupReady]);

  useEffect(() => {
    document.documentElement.dataset.theme = onboardingActive ? "dark" : app.theme;
  }, [app.theme, onboardingActive]);

  useEffect(() => {
    if (!webAuthRequired || window.location.pathname === "/auth") return;
    router.replace("/auth");
  }, [router, webAuthRequired]);

  useEffect(() => {
    if (!nativeAndroid) return;
    if (app.authUser) return;
    if (app.displaySyncStatus === "auth_required") {
      void Promise.all([
        setBraiCmdAccessKey("", "", ""),
        setBraiCmdOverlayEnabled(false),
      ]);
    }
  }, [app.authUser, app.displaySyncStatus, nativeAndroid]);

  useEffect(() => {
    if (!nativeAndroid) return;
    const retryPendingRevocation = () => void retryBraiCmdPendingAccountRevocation();
    const retryWhenVisible = () => {
      if (document.visibilityState === "visible") retryPendingRevocation();
    };
    window.addEventListener("online", retryPendingRevocation);
    document.addEventListener("visibilitychange", retryWhenVisible);
    retryPendingRevocation();
    return () => {
      window.removeEventListener("online", retryPendingRevocation);
      document.removeEventListener("visibilitychange", retryWhenVisible);
    };
  }, [nativeAndroid]);

  useEffect(() => {
    if (!nativeAndroid || !authUserId) return;
    const activeAuthUserId = authUserId;
    let cancelled = false;
    let attempt = 0;
    let retryTimer: number | null = null;
    let inFlight = false;
    let credentialReady = false;
    let credentialListener: { remove: () => Promise<void> } | null = null;

    function scheduleRetry() {
      if (cancelled || retryTimer != null) return;
      const delay = braiCmdBootstrapRetryDelay(attempt);
      attempt += 1;
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        void provision();
      }, delay);
    }

    async function provision() {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        const accountMode = await beginBraiCmdAccountCredentialMode(activeAuthUserId);
        if (!accountMode?.accountCredentialsActive && !accountMode?.legacyCredentialMode) throw new Error("brai_cmd_account_mode_missing");
        const native = await getBraiCmdState();
        if (cancelled) return;
        if (!native?.deviceId) throw new Error("brai_cmd_device_id_missing");
        const issued = await provisionBraiCmdDeviceToken({
          deviceId: native.deviceId,
          clientVersion: native.clientVersion,
          appPackage: native.appPackage,
        });
        if (cancelled) return;
        const credentialState = await setBraiCmdAccessKey(issued.token, authDisplayName, activeAuthUserId);
        if (cancelled) return;
        if (!credentialState?.accessGranted) throw new Error("brai_cmd_credential_not_saved");
        const providerSync = await syncBraiCmdProviderCredentials();
        if (cancelled) return;
        if (!providerSync?.ok) {
          if (providerSync?.code === "native_update_required") {
            await enableAuthenticatedBraiCmdMode(activeAuthUserId);
            attempt = 0;
            credentialReady = true;
            return;
          }
          throw new Error(providerSync?.code || "brai_cmd_provider_sync_failed");
        }
        await enableAuthenticatedBraiCmdMode(activeAuthUserId);
        if (cancelled) {
          await setBraiCmdAuthenticatedMode(activeAuthUserId, false);
          return;
        }
        await retryBraiCmdQueue();
        attempt = 0;
        credentialReady = true;
      } catch {
        scheduleRetry();
      } finally {
        inFlight = false;
      }
    }

    function provisionNow(force = false) {
      if (!force && credentialReady) return;
      if (force) credentialReady = false;
      if (retryTimer != null) window.clearTimeout(retryTimer);
      retryTimer = null;
      attempt = 0;
      void provision();
    }

    async function resyncProviders() {
      if (!credentialReady || cancelled || inFlight) {
        provisionNow();
        return;
      }
      inFlight = true;
      try {
        const result = await syncBraiCmdProviderCredentials();
        if (!result?.ok) {
          if (result?.code === "native_update_required") {
            await enableAuthenticatedBraiCmdMode(activeAuthUserId);
            return;
          }
          throw new Error(result?.code || "brai_cmd_provider_sync_failed");
        }
      } catch {
        credentialReady = false;
        scheduleRetry();
      } finally {
        inFlight = false;
      }
    }

    const onOnline = () => void resyncProviders();
    const onVisible = () => {
      if (document.visibilityState === "visible") void resyncProviders();
    };
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);
    void listenBraiCmdCredentialRefreshRequired(() => provisionNow(true)).then((listener) => {
      if (cancelled) void listener?.remove();
      else credentialListener = listener;
    });
    provisionNow();

    return () => {
      cancelled = true;
      void setBraiCmdAuthenticatedMode(activeAuthUserId, false);
      if (retryTimer != null) window.clearTimeout(retryTimer);
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
      void credentialListener?.remove();
    };
  }, [authDisplayName, authUserId, nativeAndroid, provisionBraiCmdDeviceToken]);

  useEffect(() => installAndroidBackHandler(() => {
    if (window.history.state?.braiMobileMenu || window.history.state?.braiMobileDockMenu || window.history.state?.braiMobileSheet || window.history.state?.braiActivityEditor || window.history.state?.braiOperationEditor || window.history.state?.braiMobileActionCreate || window.history.state?.braiInboxEditor || window.history.state?.braiMobileInboxCreate || window.history.state?.braiFactoryLog) return false;
    if (unauthEngineActiveRef.current || unauthBraiCmdActiveRef.current) {
      setUnauthEngineOpen(false);
      setUnauthBraiCmdOpen(false);
      selectSectionRef.current("actions");
      return true;
    }
    if (sectionRef.current === "actions") return false;
    if (window.history.state?.braiSection === sectionRef.current) {
      window.history.back();
    } else {
      selectSectionRef.current("actions");
    }
    return true;
  }), []);

  function renderSectionScreen(screenSection: SectionId, isActivePage: boolean) {
    const hideScreenHeader = screenSection === "draws" && drawsFullscreenActive;
    const authBlocked = app.displaySyncStatus === "auth_required" && !(unauthEngineActive && screenSection === "engine");

    return (
      <>
        {!hideScreenHeader ? (
          <ScreenHeader
            title={sectionTitle(screenSection)}
            icon={sectionIcon(screenSection)}
            syncStatus={app.displaySyncStatus}
            pendingCount={app.totalPendingCount}
            leading={isPrimarySection(screenSection) || isContextualRailSection(screenSection) ? <MobileMenuButton onClick={openMobileMenu} /> : null}
            desktopLeading={isContextualRailSection(screenSection) ? (
              <button
                type="button"
                className="grid size-7 place-items-center rounded-md border-0 bg-transparent text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={contextualRail.open ? "Закрыть контекстную панель" : "Открыть контекстную панель"}
                title={contextualRail.open ? "Закрыть контекстную панель" : "Открыть контекстную панель"}
                aria-pressed={contextualRail.open}
                onClick={() => contextualRail.setOpen(!contextualRail.open)}
              >
                {contextualRail.open ? <PanelLeftClose className="size-5" aria-hidden="true" /> : <PanelLeftOpen className="size-5" aria-hidden="true" />}
              </button>
            ) : undefined}
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
              ) : screenSection === "settings" ? (
                <ThemeButton theme={app.theme} onTheme={app.setTheme} />
              ) : null
            }
          />
        ) : null}
        {authBlocked ? (
          <AuthScreen
            busy={app.busy}
            layout="embedded"
            mode={app.authMode}
            onEmailLogin={app.onEmailLogin}
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
            workspace={actionsWorkspace}
            onSelectWorkspaceFilter={selectActionsWorkspaceFilter}
            onCreateGoal={app.onCreateGoal}
            onRestoreGoal={app.onRestoreGoal}
            onAutosaveGoalDetails={app.onAutosaveGoalDetails}
            onSetGoalStatus={app.onSetGoalStatus}
            onDeleteGoal={app.onDeleteGoal}
            onPlanGoal={app.onPlanGoal}
            onAddToGoals={app.onAddToGoals}
            onRemoveFromGoal={app.onRemoveFromGoal}
            onReorderGoal={app.onReorderGoal}
            onCreateActionInGoal={app.onCreateActionInGoal}
            contextReviews={app.contextReviews}
            relationSyncIssues={app.relationSyncIssues}
            onResolveContextDecision={app.onResolveContextDecision}
            onUndoContextDecision={app.onUndoContextDecision}
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
            onReorder={app.onReorderInbox}
            mobileCreateDraft={inboxMobileCreateDraft}
            onMobileCreateDraftChange={setInboxMobileCreateDraft}
            dockOverflowOpen={dockOverflowOpen}
            onMobileOverlayChange={app.setActionOverlayOpen}
          />
        ) : screenSection === "archive" ? (
          <ArchiveSection
            activityState={app.actions}
            localSnapshotReady={app.localSnapshotReady}
            onRestoreAction={app.onRestoreAction}
            onRestoreInbox={app.onRestoreInboxItem}
            onRailContent={isActivePage ? registerArchiveRail : undefined}
          />
        ) : screenSection === "profile" ? (
          <ProfileSection />
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
        ) : screenSection === "draws" ? (
          <DrawsSection
            theme={app.theme}
            onFullscreenChange={isActivePage ? handleDrawsFullscreenChange : undefined}
            onRailContent={isActivePage ? registerDrawsRail : undefined}
          />
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
            onDownloadApk={app.downloadApkOnce}
            onInstallApk={app.installApkOnce}
            onDownloadWebUpdate={app.downloadWebUpdateOnce}
            onRefreshEngine={app.refreshEngineOnce}
          />
        ) : screenSection === "settings" ? (
          <SettingsSection
            settings={app.appSettings}
            api={app.api}
            busy={app.busy}
            onUpdate={app.onUpdateAppSettings}
          />
        ) : screenSection === "brai-cmd" ? (
          <BraiCmdSection />
        ) : null}
      </>
    );
  }

  if (webAuthRequired) {
    return <main className="min-h-dvh bg-background" data-auth-redirect />;
  }
  if (app.localDatabaseBlocked) {
    return <LocalDatabaseBlockedScreen />;
  }
  return (
    <>
      {onboardingActive ? (
        <OnboardingFlow
          authRequired={startupReady && app.displaySyncStatus === "auth_required"}
          authMode={app.authMode}
          busy={app.busy}
          onDone={() => setOnboardingVisible(false)}
          onEmailLogin={onOnboardingEmailLogin}
          onOpenEngine={openUnauthEngine}
          onOpenNativeCmdSettings={openNativeBraiCmdSettings}
          onRequestOtp={app.onRequestOtp}
          onStartupScreenChange={setOnboardingStartupActive}
          onVerifyOtp={onOnboardingVerifyOtp}
          startupIntroComplete={startupIntroComplete}
        />
      ) : unauthEngineActive || unauthBraiCmdActive ? (
        <main className="grid h-dvh min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden bg-background px-3.5 pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)]" data-standalone-section>
          <ScreenHeader
            title={unauthEngineActive ? "Engine" : "Brai CMD"}
            icon={sectionIcon(unauthEngineActive ? "engine" : "brai-cmd")}
            syncStatus={app.displaySyncStatus}
            pendingCount={app.totalPendingCount}
            leading={<IconButton icon={ArrowLeft} label="Назад" onClick={closeUnauthSection} />}
          />
          <ScrollArea scrollbar={false} className="min-h-0">
            <div className="pb-6">
              {unauthEngineActive ? (
                <EngineSection
                  appVersionState={app.versionState}
                  bundlePublishedAt={app.bundlePublishedAt}
                  otaCheckedAt={app.otaCheckedAt}
                  otaRefreshing={app.otaRefreshing}
                  otaState={app.otaState}
                  versionCheckedAt={app.versionCheckedAt}
                  versionError={app.versionError}
                  versionRefreshing={app.versionRefreshing}
                  onDownloadApk={app.downloadApkOnce}
                  onInstallApk={app.installApkOnce}
                  onDownloadWebUpdate={app.downloadWebUpdateOnce}
                  onRefreshEngine={app.refreshEngineOnce}
                />
              ) : <BraiCmdSection />}
            </div>
          </ScrollArea>
        </main>
      ) : (
        <SidebarProvider
      open={false}
      inert={domainMutationsBlocked}
      aria-busy={domainMutationsBlocked}
      className={cx(
        "app-shell h-dvh min-h-0 overflow-hidden [--sticky-top-offset:0px] max-[860px]:grid max-[860px]:grid-rows-[minmax(0,1fr)_auto] max-[860px]:[--mobile-top-padding:env(safe-area-inset-top)]",
        app.actionOverlayOpen && "has-mobile-action-overlay max-[860px]:pb-0",
        app.mobileMenuOpen && "has-mobile-menu",
        drawsFullscreenActive && "max-[860px]:grid-rows-[minmax(0,1fr)]",
      )}
      data-app-shell
    >
      {!drawsFullscreenActive && !mobileViewport ? (
        <DesktopRail
          section={visibleSection}
          appVersionState={app.versionState}
          otaRefreshing={app.otaRefreshing}
          otaState={app.otaState}
          pendingCount={app.totalPendingCount}
          versionError={app.versionError}
          versionRefreshing={app.versionRefreshing}
          syncStatus={app.displaySyncStatus}
          authUser={app.authUser}
          onProfile={() => app.selectSection("profile")}
          onSettings={app.openSettingsPage}
          onBraiCmd={openBraiCmd}
          onEngine={() => app.selectSection("engine")}
          onArchive={() => app.selectSection("archive")}
          onLogout={app.onLogout}
        />
      ) : null}
      {!drawsFullscreenActive && contextualRail.supported ? (
        <ContextualRail open={contextualRail.open} width={contextualRail.width} onWidth={contextualRail.setWidth}>
          {activeContextualContent}
        </ContextualRail>
      ) : null}
      <SidebarInset className={cx("main-view m-0 h-full min-h-0 w-full min-w-0 overflow-hidden max-[860px]:overscroll-contain max-[860px]:[touch-action:pan-y]", app.swipeNavigation.visual && "is-section-swiping")} {...mobileMenuSwipe.handlers}>
        {visibleSection === "focus" ? <FocusBackground active={app.active} mode={app.focusBackground} /> : null}
        <ScrollArea scrollbar={false} className="main-scroll relative z-[1] h-full [&>[data-slot=scroll-area-viewport]>div]:h-full max-[860px]:[&>[data-slot=scroll-area-viewport]]:overscroll-contain max-[860px]:[&>[data-slot=scroll-area-viewport]]:[touch-action:pan-y]">
          <div className="section-swipe-stage relative m-0 h-full min-h-0 w-full overflow-x-hidden overflow-y-visible">
            <section
              className={cx("section-page section-page-current relative z-[1] min-w-0 [backface-visibility:hidden]", drawsFullscreenActive ? FULLSCREEN_SECTION_PAGE_CLASS : SECTION_PAGE_INSET_CLASS, app.swipeNavigation.visual && "will-change-transform")}
              data-section-page={visibleSection}
              style={sectionSwipePageStyle(app.swipeNavigation.visual, "current")}
            >
              {renderSectionScreen(visibleSection, true)}
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
      {!drawsFullscreenActive ? (
        <MainDock
          section={visibleSection}
          hidden={app.actionOverlayOpen || app.mobileContextPanel != null}
          mobileViewport={mobileViewport}
          onSection={app.selectSection}
          swipeHandlers={app.swipeNavigation.handlers}
          timer={app.timer}
        />
      ) : null}
      {!drawsFullscreenActive ? (
        <>
          <MobileDockOverflowButton
            side="left"
            hasUpdate={engineView.hasUpdate}
            hidden={app.mobileMenuOpen || mobileDockMenu === "left" || app.actionOverlayOpen}
            onClick={() => setMobileDockMenu("left")}
          />
          <MobileDockOverflowButton
            side="right"
            open={mobileDockMenu === "right"}
            hidden={app.mobileMenuOpen || mobileDockMenu === "left" || app.actionOverlayOpen}
            onClick={() => setMobileDockMenu((current) => current === "right" ? null : "right")}
          />
        </>
      ) : null}
      {app.mobileMenuOpen && !drawsFullscreenActive ? (
        <MobileProfileDrawer
          onClose={() => app.setMobileMenuOpen(false)}
        >
          {visibleSection === "actions" ? (
            <ActionsSidebarContent workspace={actionsWorkspace} contextReviews={app.contextReviews} onSelect={(filter) => { selectActionsWorkspaceFilter(filter); requestMobileProfileDrawerClose(); }} onCreateGoal={app.onCreateGoal} onRestoreGoal={app.onRestoreGoal} onResolve={app.onResolveContextDecision} onUndo={app.onUndoContextDecision} />
          ) : activeContextualContent}
        </MobileProfileDrawer>
      ) : null}
      {mobileDockMenu && !drawsFullscreenActive ? (
        <MobileDockOverflowSheet
          side={mobileDockMenu}
          section={visibleSection}
          authUser={app.authUser}
          engineDownloading={engineDownloading}
          engineHasUpdate={engineView.hasUpdate}
          onClose={() => setMobileDockMenu(null)}
          onProfile={() => app.selectSection("profile")}
          onSettings={app.openSettingsPage}
          onBraiCmd={openBraiCmd}
          onDraws={() => app.selectSection("draws")}
          onEngine={() => app.selectSection("engine")}
          onArchive={() => app.selectSection("archive")}
          onLogout={app.onLogout}
        />
      ) : null}
      {app.mobileContextPanel === "actions-info" && visibleSection === "actions" ? (
        <MobileContextSheet label="Информация о действиях" onClose={() => app.setMobileContextPanel(null)} onCloseStart={app.markMobileContextPanelClosing}>
          <ActionsInfoPanel mobile>
            <ActionsSidebarContent workspace={actionsWorkspace} contextReviews={app.contextReviews} onSelect={(filter) => { selectActionsWorkspaceFilter(filter); app.setMobileContextPanel(null); }} onCreateGoal={app.onCreateGoal} onRestoreGoal={app.onRestoreGoal} onResolve={app.onResolveContextDecision} onUndo={app.onUndoContextDecision} />
          </ActionsInfoPanel>
        </MobileContextSheet>
      ) : null}
      {app.mobileContextPanel === "inbox-info" && visibleSection === "inbox" ? (
        <MobileContextSheet label="Информация о входящих" onClose={() => app.setMobileContextPanel(null)} onCloseStart={app.markMobileContextPanelClosing}>
          <ActionsInfoPanel label="Информация о входящих" mobile />
        </MobileContextSheet>
      ) : null}
      {app.mobileContextPanel === "focus-goal" && visibleSection === "focus" ? (
        <FocusContextPanelSheet panel="goal" history={app.history} goal={app.goal} todayKey={app.todayKey} onClose={() => app.setMobileContextPanel(null)} onCloseStart={app.markMobileContextPanelClosing} onDeleteSession={app.onDeleteFocusSession} onEditInterval={app.onEditFocusInterval} onEditSession={app.onEditFocusSession} />
      ) : null}
      {app.mobileContextPanel === "focus-history" && visibleSection === "focus" ? (
        <FocusContextPanelSheet panel="history" history={app.history} goal={app.goal} todayKey={app.todayKey} onClose={() => app.setMobileContextPanel(null)} onCloseStart={app.markMobileContextPanelClosing} onDeleteSession={app.onDeleteFocusSession} onEditInterval={app.onEditFocusInterval} onEditSession={app.onEditFocusSession} />
      ) : null}
        </SidebarProvider>
      )}
      {nativeAndroid === true ? (
        <AppStartupSplash
          ready={startupReady}
          persist={onboardingActive && onboardingStartupActive}
          onIntroComplete={handleStartupIntroComplete}
        />
      ) : null}
    </>
  );
}

async function enableAuthenticatedBraiCmdMode(userId: string): Promise<void> {
  const state = await setBraiCmdAuthenticatedMode(userId, true);
  if (!state?.overlayEnabled || state.voiceOnlyMode !== false || state.queuePausedMode !== false) {
    throw new Error("brai_cmd_mode_not_applied");
  }
}

function useMountedMobileNavigationViewport(): boolean {
  return useSyncExternalStore(
    subscribeMobileNavigationViewport,
    isMobileNavigationViewport,
    () => false,
  );
}

function useMountedNativeAndroid(): boolean | null {
  return useSyncExternalStore(
    subscribeNativeAndroid,
    isNativeAndroid,
    () => null,
  );
}

function subscribeNativeAndroid() {
  return () => undefined;
}

function isNativeAndroid(): boolean {
  return isNativeShell() && platformName() === "android";
}

function shouldKeepStoredLockedOnboarding(): boolean {
  const state = loadOnboardingState();
  return state.complete && state.step === "locked";
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
