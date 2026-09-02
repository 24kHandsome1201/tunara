import { useCallback, useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { requestSafeAppRelaunch } from "@/app/app-lifecycle";

export type UpdateStatus = "idle" | "checking" | "current" | "available" | "downloading" | "restartReady" | "restarting" | "error";

export function useAppUpdate(): {
  appVersion: string;
  updateStatus: UpdateStatus;
  updateVersion: string;
  updateProgress: number | null;
  canInstallUpdate: boolean;
  checkForUpdates: () => Promise<void>;
  installUpdate: () => Promise<void>;
} {
  const [appVersion, setAppVersion] = useState("");
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>("idle");
  const [updateVersion, setUpdateVersion] = useState("");
  const [updateProgress, setUpdateProgress] = useState<number | null>(null);
  const updateRef = useRef<Update | null>(null);
  const checkStartedRef = useRef(false);
  const restartInFlightRef = useRef(false);

  useEffect(() => {
    void getVersion().then(setAppVersion).catch(() => {});
    return () => {
      const update = updateRef.current;
      updateRef.current = null;
      if (update) void update.close();
    };
  }, []);

  const checkForUpdates = useCallback(async () => {
    if (updateStatus === "checking" || updateStatus === "downloading" || updateStatus === "restarting") return;
    setUpdateStatus("checking");
    setUpdateProgress(null);
    const previous = updateRef.current;
    updateRef.current = null;
    if (previous) await previous.close().catch(() => {});
    try {
      const update = await check({ timeout: 15_000 });
      updateRef.current = update;
      if (!update) {
        setUpdateVersion("");
        setUpdateStatus("current");
        return;
      }
      setUpdateVersion(update.version);
      setUpdateStatus("available");
    } catch (error) {
      console.warn("[Settings] update check failed", error);
      setUpdateStatus("error");
    }
  }, [updateStatus]);

  const installUpdate = async () => {
    const update = updateRef.current;
    if (!update || updateStatus === "downloading" || updateStatus === "restarting") return;
    const restart = () => {
      if (restartInFlightRef.current) return;
      const started = requestSafeAppRelaunch(relaunch, {
        onStarting: () => {
          restartInFlightRef.current = true;
          setUpdateStatus("restarting");
        },
        onFailure: (error) => {
          restartInFlightRef.current = false;
          console.warn("[Settings] safe update restart failed", error);
          setUpdateStatus("restartReady");
        },
      });
      if (!started) setUpdateStatus("restartReady");
    };
    if (updateStatus === "restartReady") {
      restart();
      return;
    }
    setUpdateStatus("downloading");
    setUpdateProgress(0);
    let downloaded = 0;
    let total: number | undefined;
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength;
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          setUpdateProgress(total ? Math.min(99, Math.round((downloaded / total) * 100)) : null);
        } else {
          setUpdateProgress(100);
        }
      });
      restart();
    } catch (error) {
      console.warn("[Settings] update installation failed", error);
      setUpdateStatus("error");
      setUpdateProgress(null);
    }
  };

  useEffect(() => {
    if (checkStartedRef.current) return;
    checkStartedRef.current = true;
    void checkForUpdates();
  }, [checkForUpdates]);

  const canInstallUpdate = updateStatus === "available" || updateStatus === "restartReady" || (updateStatus === "error" && !!updateRef.current);
  return { appVersion, updateStatus, updateVersion, updateProgress, canInstallUpdate, checkForUpdates, installUpdate };
}
