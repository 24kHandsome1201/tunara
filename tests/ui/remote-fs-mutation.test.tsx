import { mockIPC } from "@tauri-apps/api/mocks";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { performRemoteChmod, performRemoteMutation } from "@/modules/ssh/remote-fs/actions";
import { RemoteFsMutationDialog } from "@/modules/ssh/remote-fs/RemoteFsMutationDialog";
import { formatRemoteMode, RemoteMetadataPanel } from "@/modules/ssh/remote-fs/RemoteMetadataPanel";
import type { MutationRequestV1 } from "@/modules/ssh/remote-fs/bridge";

function deleteRequest(): MutationRequestV1 {
  return {
    operationId: "delete-1",
    binding: {
      logicalSessionId: "logical-1",
      physicalPtyId: 17,
      transportGeneration: "backend-generation",
    },
    operation: { kind: "delete", path: "/srv/app/broken-link" },
    precondition: {
      source: {
        state: "present",
        identity: { kind: "symlink", size: 14, mode: 0o120777, modifiedAt: 20 },
      },
      sourceParent: { kind: "directory", mode: 0o40755, modifiedAt: 10 },
    },
  };
}

describe("remote filesystem mutation boundary", () => {
  test("formats ordinary permissions while keeping special bits separately read-only", () => {
    expect(formatRemoteMode(0o104754)).toEqual({
      rwx: "rwxr-xr--",
      octal: "0754",
      special: "4000",
    });
  });

  test("response loss invokes read-only reconciliation and never retries mutation", async () => {
    const commands: string[] = [];
    mockIPC((command) => {
      commands.push(command);
      if (command === "ssh_fs_mutate_v1") throw new Error("response lost");
      if (command === "ssh_fs_reconcile_mutation_v1") {
        return {
          operationId: "delete-1",
          status: "desiredStateObserved",
          message: "desired state observed",
          atomic: false,
        };
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const outcome = await performRemoteMutation(deleteRequest());

    expect(outcome.reconciled).toBe(true);
    expect(outcome.result.status).toBe("desiredStateObserved");
    expect(commands).toEqual(["ssh_fs_mutate_v1", "ssh_fs_reconcile_mutation_v1"]);
  });

  test("a rejected chmod refreshes metadata but never claims it caused matching mode", async () => {
    const commands: string[] = [];
    mockIPC((command) => {
      commands.push(command);
      if (command === "ssh_fs_chmod_v1") throw new Error("command rejected or response lost");
      if (command === "ssh_fs_stat_v1") {
        return {
          path: "/srv/file",
          kind: "file",
          precondition: { kind: "file", size: 3, mode: 0o100640, modifiedAt: 20 },
          parentPrecondition: { kind: "directory", mode: 0o40755, modifiedAt: 10 },
          mode: 0o100640,
          capability: { chmod: "unknown", handleSetstat: "unknown", posixRename: "unknown" },
        };
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const result = await performRemoteChmod({
      operationId: "chmod-1",
      binding: deleteRequest().binding,
      path: "/srv/file",
      mode: 0o640,
      expected: { kind: "file", size: 3, mode: 0o100644, modifiedAt: 20 },
      expectedParent: { kind: "directory", mode: 0o40755, modifiedAt: 10 },
    });

    expect(result.status).toBe("outcomeUnknown");
    expect(commands).toEqual(["ssh_fs_chmod_v1", "ssh_fs_stat_v1"]);
  });

  test("destructive dialog shows the full host, absolute path, and symlink kind", async () => {
    mockIPC((command) => {
      if (command === "ssh_fs_mutate_v1") {
        return { operationId: "delete-1", status: "applied", message: "accepted", atomic: false };
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const complete = vi.fn();
    render(
      <RemoteFsMutationDialog
        host="deploy@production.example:2222"
        request={deleteRequest()}
        onClose={vi.fn()}
        onComplete={complete}
      />,
    );

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("deploy@production.example:2222")).toBeTruthy();
    expect(screen.getByText("/srv/app/broken-link")).toBeTruthy();
    expect(screen.getByText("symlink")).toBeTruthy();
    expect(screen.getByText(/Deletes and copies are not recursive/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Delete remote item" }));
    await waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("status").textContent).toContain("applied");
  });

  test("metadata panel displays owner, octal/rwx mode, and refuses symlink chmod", async () => {
    mockIPC((command) => {
      if (command === "ssh_fs_stat_v1") {
        return {
          path: "/srv/current",
          kind: "symlink",
          precondition: { kind: "symlink", size: 8, mode: 0o120777, modifiedAt: 20 },
          parentPrecondition: { kind: "directory", mode: 0o40755, modifiedAt: 10 },
          mode: 0o120777,
          uid: 1000,
          group: "deploy",
          linkTarget: "releases/missing",
          capability: { chmod: "unknown", handleSetstat: "unsupported", posixRename: "unknown" },
        };
      }
      throw new Error(`unexpected command: ${command}`);
    });

    render(
      <RemoteMetadataPanel
        binding={deleteRequest().binding}
        path="/srv/current"
        host="deploy@production.example"
      />,
    );

    expect(await screen.findByText("rwxrwxrwx (0777)")).toBeTruthy();
    expect(screen.getByText("1000:deploy")).toBeTruthy();
    expect(screen.getByText("releases/missing")).toBeTruthy();
    expect(screen.getByText(/Can’t change permissions on a symbolic link/i)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Apply permissions" }) as HTMLButtonElement).disabled).toBe(true);
  });

  test("unsupported chmod capability disables editing and never invokes chmod", async () => {
    const commands: string[] = [];
    mockIPC((command) => {
      commands.push(command);
      if (command === "ssh_fs_stat_v1") return {
        path: "/srv/file", kind: "file",
        precondition: { kind: "file", size: 3, mode: 0o100644, modifiedAt: 20 },
        parentPrecondition: { kind: "directory", mode: 0o40755, modifiedAt: 10 },
        mode: 0o100644,
        capability: { chmod: "unsupported", handleSetstat: "unsupported", posixRename: "unknown" },
      };
      throw new Error(`unexpected command: ${command}`);
    });
    render(<RemoteMetadataPanel binding={deleteRequest().binding} path="/srv/file" host="production" />);

    const input = await screen.findByLabelText("Permissions (e.g. 0644)") as HTMLInputElement;
    const apply = screen.getByRole("button", { name: "Apply permissions" }) as HTMLButtonElement;
    expect(input.disabled).toBe(true);
    expect(apply.disabled).toBe(true);
    fireEvent.click(apply);
    expect(commands).toEqual(["ssh_fs_stat_v1"]);
  });
});
