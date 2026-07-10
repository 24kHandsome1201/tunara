import type { Session } from "./types";
import { useT } from "@/modules/i18n";
import { currentWorkspaceWorktree } from "@/modules/git/workspace-context";

export function WorkspaceSourceChip({ session }: { session: Session }) {
  const t = useT();
  const workspace = session.workspace;
  const worktree = currentWorkspaceWorktree(workspace);
  if (!workspace || !worktree) {
    if (session.workspaceState !== "unavailable") return null;
    return (
      <span title={t("workspace.unavailable_hint")} style={{ height: 22, display: "inline-flex", alignItems: "center", gap: 5, border: "1px solid var(--c-border-1)", borderRadius: "var(--r-pill)", background: "var(--c-bg-white)", color: "var(--c-error)", padding: "0 7px", fontSize: "var(--fs-badge)", whiteSpace: "nowrap" }}>
        <span aria-hidden="true">!</span>
        {t("workspace.unavailable")}
      </span>
    );
  }

  const branch = worktree.detached
    ? t("workspace.detached")
    : worktree.branch ?? t("workspace.unknown_branch");
  const title = `${workspace.repository.host ? `${workspace.repository.host} / ` : ""}${workspace.repository.name} / ${worktree.path} / ${branch}`;

  return (
    <span
      title={title}
      style={{
        minWidth: 0,
        maxWidth: 190,
        height: 22,
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        border: "1px solid var(--c-border-1)",
        borderRadius: "var(--r-pill)",
        background: "var(--c-bg-white)",
        color: "var(--c-text-4)",
        padding: "0 7px",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--fs-badge)",
        whiteSpace: "nowrap",
        overflow: "hidden",
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: !worktree.available
            ? "var(--c-error)"
            : worktree.dirtyFiles === undefined
              ? "var(--c-text-6)"
              : worktree.dirtyFiles > 0
                ? "var(--c-warning)"
                : "var(--c-success)",
          flexShrink: 0,
        }}
      />
      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
        {workspace.repository.name}/{worktree.name}
      </span>
    </span>
  );
}
