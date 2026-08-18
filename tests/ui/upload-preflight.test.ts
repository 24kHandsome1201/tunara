import { beforeEach, describe, expect, it } from "vitest";
import { mockIPC } from "@tauri-apps/api/mocks";
import { actionableUploadConflicts, queueLocalTransferPaths } from "@/ui/file-explorer/upload-preflight";
import { useTransferStore } from "@/modules/ssh/transfer-store";
import type { UploadPlanV1 } from "@/modules/ssh/transfer-bridge";

const binding = {
  logicalSessionId: "logical",
  physicalPtyId: 7,
  transportGeneration: "generation",
};
const t = (key: string) => key;
const tick = () => new Promise<void>((resolve) => queueMicrotask(resolve));

function plan(): UploadPlanV1 {
  return {
    planId: "opaque-plan",
    expiresAt: Date.now() + 60_000,
    binding,
    items: [{
      itemId: "file",
      sourcePath: "/local/file.txt",
      relativePath: "file.txt",
      kind: "file",
      bytes: 4,
      proposedDestination: "/remote/file.txt",
      destination: "absent",
    }],
  };
}

beforeEach(() => useTransferStore.getState().replaceItemsForTest([]));

describe("backend-owned upload preflight", () => {
  it("submits one preflight and never repeats materialize after a lost response", async () => {
    const commands: string[] = [];
    mockIPC((command, payload) => {
      commands.push(command);
      if (command === "ssh_upload_preflight_v1") return plan();
      if (command === "ssh_upload_materialize_v1") throw new Error("response lost");
      if (command === "ssh_upload_materialization_reconcile_v1") {
        const request = (payload as { request: { operationId: string } }).request;
        return {
          planId: "opaque-plan", operationId: request.operationId, status: "ready", partialDirectories: [],
          items: [{ itemId: "file", status: "ready", destinationPath: "/remote/file.txt" }],
          descriptors: [{ itemId: "file", sourcePath: "/local/file.txt", destinationPath: "/remote/file.txt", overwrite: false }],
        };
      }
      if (command === "ssh_transfer_upload") return { outcome: { status: "completed", bytesTransferred: 4 } };
      throw new Error(`unexpected command: ${command}`);
    });

    await expect(queueLocalTransferPaths({ binding, paths: ["/local/file.txt"], destinationRoot: "/remote", t })).resolves.toMatchObject({ status: "queued", files: 1 });
    await tick();
    expect(commands.filter((command) => command === "ssh_upload_preflight_v1")).toHaveLength(1);
    expect(commands.filter((command) => command === "ssh_upload_materialize_v1")).toHaveLength(1);
    expect(commands.filter((command) => command === "ssh_upload_materialization_reconcile_v1")).toHaveLength(1);
  });

  it("publishes zero transfers while materialization remains outcomeUnknown", async () => {
    const commands: string[] = [];
    mockIPC((command, payload) => {
      commands.push(command);
      if (command === "ssh_upload_preflight_v1") return plan();
      if (command === "ssh_upload_materialize_v1" || command === "ssh_upload_materialization_reconcile_v1") {
        const request = (payload as { request: { operationId: string } }).request;
        return {
          planId: "opaque-plan", operationId: request.operationId, status: "outcomeUnknown", descriptors: [], partialDirectories: ["/remote/partial"],
          items: [{ itemId: "file", status: "outcomeUnknown" }],
        };
      }
      throw new Error(`unexpected command: ${command}`);
    });

    await expect(queueLocalTransferPaths({ binding, paths: ["/local/file.txt"], destinationRoot: "/remote", t })).resolves.toEqual({ status: "prepareFailed", outcomeUnknown: true });
    expect(commands.filter((command) => command === "ssh_upload_materialize_v1")).toHaveLength(1);
    expect(commands.filter((command) => command === "ssh_upload_materialization_reconcile_v1")).toHaveLength(1);
    expect(commands).not.toContain("ssh_transfer_upload");
    expect(useTransferStore.getState().materializeItems()).toEqual([]);
  });

  it("asks only for the blocking directory ancestor, not synthetic descendant conflicts", () => {
    const value = plan();
    value.items = [
      { ...value.items[0], itemId: "root", sourcePath: "/local/root", relativePath: "root", kind: "dir", proposedDestination: "/remote/root", destination: "blockingNonDirectory" },
      { ...value.items[0], itemId: "child", relativePath: "root/child.txt", proposedDestination: "/remote/root/child.txt", destination: "blockingNonDirectory" },
      { ...value.items[0], itemId: "peer", relativePath: "peer.txt", proposedDestination: "/remote/peer.txt", destination: "fileConflict" },
    ];
    expect(actionableUploadConflicts(value).map((item) => item.itemId)).toEqual(["root", "peer"]);
  });
});
