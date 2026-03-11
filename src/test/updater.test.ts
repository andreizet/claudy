import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  checkMock,
  relaunchMock,
  downloadAndInstallMock,
  notificationsShowMock,
  notificationsUpdateMock,
} = vi.hoisted(() => ({
  checkMock: vi.fn(),
  relaunchMock: vi.fn(),
  downloadAndInstallMock: vi.fn(),
  notificationsShowMock: vi.fn(),
  notificationsUpdateMock: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-updater", () => ({
  check: checkMock,
}));

vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: relaunchMock,
}));

vi.mock("@mantine/notifications", () => ({
  notifications: {
    show: notificationsShowMock,
    update: notificationsUpdateMock,
  },
}));

import { checkForAppUpdatesOnStartup, resetStartupUpdateCheckForTests } from "../updater";

describe("checkForAppUpdatesOnStartup", () => {
  beforeEach(() => {
    resetStartupUpdateCheckForTests();
    checkMock.mockReset();
    relaunchMock.mockReset();
    downloadAndInstallMock.mockReset();
    notificationsShowMock.mockReset();
    notificationsUpdateMock.mockReset();
    vi.restoreAllMocks();

    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
  });

  it("downloads and relaunches when the user accepts the update", async () => {
    checkMock.mockResolvedValue({
      version: "0.3.0",
      body: "Adds OTA updates.",
      downloadAndInstall: downloadAndInstallMock,
    });
    downloadAndInstallMock.mockResolvedValue(undefined);
    relaunchMock.mockResolvedValue(undefined);
    vi.spyOn(window, "confirm").mockReturnValue(true);

    await checkForAppUpdatesOnStartup();

    expect(checkMock).toHaveBeenCalledTimes(1);
    expect(downloadAndInstallMock).toHaveBeenCalledTimes(1);
    expect(relaunchMock).toHaveBeenCalledTimes(1);
    expect(notificationsShowMock).toHaveBeenCalledWith(expect.objectContaining({
      title: "Installing update",
      loading: true,
    }));
    expect(notificationsUpdateMock).toHaveBeenCalledWith(expect.objectContaining({
      title: "Update installed",
    }));
  });

  it("does nothing when no update is available", async () => {
    checkMock.mockResolvedValue(null);

    await checkForAppUpdatesOnStartup();

    expect(checkMock).toHaveBeenCalledTimes(1);
    expect(downloadAndInstallMock).not.toHaveBeenCalled();
    expect(relaunchMock).not.toHaveBeenCalled();
    expect(notificationsShowMock).not.toHaveBeenCalled();
  });

  it("deduplicates repeated startup checks", async () => {
    checkMock.mockRejectedValue(new Error("network down"));

    await Promise.all([
      checkForAppUpdatesOnStartup(),
      checkForAppUpdatesOnStartup(),
    ]);

    expect(checkMock).toHaveBeenCalledTimes(1);
    expect(notificationsShowMock).toHaveBeenCalledTimes(1);
    expect(notificationsShowMock).toHaveBeenCalledWith(expect.objectContaining({
      title: "Update check failed",
      message: "network down",
    }));
  });
});
