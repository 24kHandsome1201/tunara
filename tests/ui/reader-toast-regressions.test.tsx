import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { ReaderPane } from "@/ui/ReaderPane";
import { ToastContainer } from "@/ui/Toast";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import type { Session } from "@/ui/types";
import { copyText } from "@/ui/lib/clipboard";
import { openRemoteInExternalEditor } from "@/modules/ssh/remote-external-edit";

vi.mock("@/ui/FilePreview", () => ({ FilePreview: () => <div>preview</div> }));
vi.mock("@/ui/lib/clipboard", () => ({ copyText: vi.fn() }));
vi.mock("@/modules/ssh/remote-external-edit", () => ({ openRemoteInExternalEditor: vi.fn() }));

function remoteSession(phase: "ready" | "disconnected" = "ready", generation = "generation-1"): Session {
  return {
    id: "reader-remote",
    title: "Remote",
    dir: "/srv/app",
    branch: "main",
    runState: "idle",
    updatedAt: 1,
    ptyId: 41,
    transportGeneration: generation,
    remote: { host: "example.test", port: 22, user: "dev" },
    connection: { transport: "ssh", phase, source: "backend", updatedAt: 1 },
  };
}

function renderReader(session: Session) {
  useUIStore.setState({ readers: {
    [session.id]: {
      current: { filePath: "/srv/app/readme.md", fileName: "readme.md" },
      history: [{ filePath: "/srv/app/readme.md", fileName: "readme.md" }],
      historyIndex: 0,
      dirty: false,
    },
  } });
  useSessionsStore.setState({ sessions: [session] });
  return render(<ReaderPane session={session} active />);
}

test("remote reader disables external edit without a live binding", async () => {
  renderReader(remoteSession("disconnected"));
  fireEvent.click(screen.getByRole("button", { name: "More actions" }));
  expect((await screen.findByRole("menuitem", { name: "Edit in external editor" })).getAttribute("aria-disabled")).toBe("true");
  expect(openRemoteInExternalEditor).not.toHaveBeenCalled();
});

test("remote reader rejects a binding replaced after its menu opened", async () => {
  const initial = remoteSession();
  renderReader(initial);
  fireEvent.click(screen.getByRole("button", { name: "More actions" }));
  const item = await screen.findByRole("menuitem", { name: "Edit in external editor" });
  useSessionsStore.setState({ sessions: [remoteSession("ready", "generation-2")] });
  fireEvent.click(item);
  expect(openRemoteInExternalEditor).not.toHaveBeenCalled();
  await waitFor(() => expect(useUIStore.getState().toasts.slice(-1)[0]).toMatchObject({
    title: "Edit in external editor",
    variant: "error",
  }));
});

test("error toast reports copy success only after success and remains retryable after failure", async () => {
  vi.mocked(copyText).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  useUIStore.setState({ toasts: [] });
  useUIStore.getState().addToast({ title: "Failure", subtitle: "Details", variant: "error" });
  render(<ToastContainer />);
  const copy = screen.getByRole("button", { name: "Copy error" });

  fireEvent.click(copy);
  await waitFor(() => expect(copy.getAttribute("aria-label")).toBe("Copy error"));
  expect(useUIStore.getState().toasts.some((toast) => toast.title === "Copy failed")).toBe(true);

  fireEvent.click(copy);
  await waitFor(() => expect(copy.getAttribute("aria-label")).toBe("Copied"));
  expect(copyText).toHaveBeenCalledTimes(2);
});
