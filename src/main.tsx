// Must run before any plugin module can load: trusted plugins import the
// host's React / @quadflow/* through the import map + these globals (§8.3).
import { installSharedModules } from "./plugins/shared";
import ReactDOM from "react-dom/client";
import App from "./App";
import FloatingWindowApp from "./FloatingWindowApp";
import { isFloatingWindow } from "./lib/windowSync";
import { installGlobalDiagnosticsHandlers, osApi } from "./lib/tauri-api";
import { configureUi } from "@quadflow/ui";
import { useOverlayStore } from "./stores/overlayStore";
import { appSettingsReady } from "./stores/appSettingsStore";
import { initWorkspaceTemplates } from "./lib/workspaceTemplates";
import { usePluginRegistry } from "./plugins/registry";
import { activateStartupPlugins } from "./plugins/loader";
import { ensureToaster } from "./plugins/hostApi/hostLayer";

installSharedModules();

// Install crash + breadcrumb handlers BEFORE React mounts. Any
// uncaught JS error or unhandled promise rejection from this point
// onward is captured into a structured CrashReport via the backend
// diagnostics module — same shape as Rust panics + Windows SEH faults,
// landing in the same folder, picked up by the same bundle.
installGlobalDiagnosticsHandlers();

// @quadflow/ui floating components (Menu, Modal, Popover, Select, …) register
// with the shell overlay registry so native views hide under them (§6.7).
configureUi({
  overlay: {
    register: (id) => useOverlayStore.getState().registerOverlay(id),
    unregister: (id) => useOverlayStore.getState().unregisterOverlay(id),
  },
});
// Mount the shared toast stack up front so shell toasts render before any
// plugin has shown one.
ensureToaster();

// Preload OS info (Windows build number) so xterm terminals get the correct
// `windowsPty` options synchronously when they are created.
osApi.getInfo().catch(() => {});

const isFloating = isFloatingWindow();

function RootApp() {
  if (isFloating) {
    return <FloatingWindowApp />;
  }
  return <App />;
}

// Persisted settings live in the core app DB (no localStorage): load them
// before the first render, bounded so a failing backend never blocks the UI.
async function bootstrap() {
  // Plugin registry (non-blocking): contributions for the palette + tiles,
  // then `onStartup` activation of trusted plugins.
  void usePluginRegistry.getState().load().then(activateStartupPlugins);
  await Promise.race([
    Promise.all([appSettingsReady, initWorkspaceTemplates()]),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <RootApp />
  );
}
void bootstrap();
