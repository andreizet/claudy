import { notifications } from "@mantine/notifications";

const UPDATE_NOTIFICATION_ID = "claudy-app-update";
let startupUpdateCheckPromise: Promise<void> | null = null;

function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function formatUpdatePrompt(version: string, body?: string | null) {
  const notes = body?.trim();
  if (!notes) {
    return `Claudy ${version} is available. Download and install it now?`;
  }

  const preview = notes.length > 280 ? `${notes.slice(0, 277)}...` : notes;
  return `Claudy ${version} is available.\n\n${preview}\n\nDownload and install it now?`;
}

export async function checkForAppUpdatesOnStartup() {
  if (!isTauriRuntime()) return;
  if (startupUpdateCheckPromise) return startupUpdateCheckPromise;

  startupUpdateCheckPromise = (async () => {
    try {
      const [{ check }, { relaunch }] = await Promise.all([
        import("@tauri-apps/plugin-updater"),
        import("@tauri-apps/plugin-process"),
      ]);

      const update = await check();

      if (!update) return;

      const releaseNotes = (update as { body?: string | null }).body ?? null;

      const shouldInstall = window.confirm(
        formatUpdatePrompt(update.version, releaseNotes)
      );
      if (!shouldInstall) {
        notifications.show({
          title: "Update available",
          message: `Claudy ${update.version} is ready to install from GitHub Releases.`,
          color: "blue",
        });
        return;
      }

      notifications.show({
        id: UPDATE_NOTIFICATION_ID,
        title: "Installing update",
        message: `Downloading Claudy ${update.version}...`,
        loading: true,
        autoClose: false,
        withCloseButton: false,
      });

      await update.downloadAndInstall();

      notifications.update({
        id: UPDATE_NOTIFICATION_ID,
        title: "Update installed",
        message: "Restarting Claudy to finish applying the update.",
        color: "teal",
        loading: false,
        autoClose: 4000,
        withCloseButton: true,
      });

      await relaunch();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to check for app updates.";
      notifications.show({
        title: "Update check failed",
        message,
        color: "red",
      });
    }
  })();

  return startupUpdateCheckPromise;
}

export function resetStartupUpdateCheckForTests() {
  startupUpdateCheckPromise = null;
}
