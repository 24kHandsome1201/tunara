import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useT } from "@/modules/i18n";
import { useUIStore } from "@/state/ui";
import { FolderIcon } from "../../icons";

export function DefaultFolderSetting() {
  const t = useT();
  const folder = useUIStore((s) => s.defaultTerminalFolder);
  const setFolder = useUIStore((s) => s.setDefaultTerminalFolder);
  const [error, setError] = useState(false);

  async function chooseFolder() {
    setError(false);
    try {
      const choice = await open({
        directory: true,
        multiple: false,
        title: t("settings.folder.choose"),
        ...(folder ? { defaultPath: folder } : {}),
      });
      if (typeof choice === "string") setFolder(choice);
    } catch {
      setError(true);
    }
  }

  return (
    <section className="settings-everyday-row" aria-labelledby="settings-folder-title">
      <div>
        <h2 id="settings-folder-title" className="settings-layout-label">{t("settings.folder.title")}</h2>
        <p className="settings-layout-hint">{t("settings.folder.hint")}</p>
        {error && <p className="settings-row-error" role="alert">{t("settings.folder.error")}</p>}
      </div>
      <div className="settings-folder-actions">
        {folder && (
          <button type="button" className="settings-action-button settings-row-action hover-bg" onClick={() => { setError(false); setFolder(""); }}>
            {t("settings.folder.reset")}
          </button>
        )}
        <button
          type="button"
          className="settings-action-button settings-row-action settings-folder-choice hover-bg"
          aria-label={`${t("settings.folder.choose")}: ${folder || t("settings.folder.home")}`}
          title={folder || t("settings.folder.choose")}
          onClick={() => { void chooseFolder(); }}
        >
          <FolderIcon size={14} />
          <span>{folder || t("settings.folder.home")}</span>
        </button>
      </div>
    </section>
  );
}
