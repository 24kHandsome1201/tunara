import { invoke } from "@tauri-apps/api/core";
import type { ResourceRef } from "@/modules/resources/resource-ref";
import { isFileViewWindow, type FileViewWindow } from "@/modules/fs/file-view-window";

export const FILE_HEAD_LINE_PRESETS = [100, 500, 1_000, 2_000] as const;
export const DEFAULT_FILE_HEAD_LINES = 1_000;
export const MAX_FILE_HEAD_LINES = 2_000;
export const MAX_FILE_HEAD_BYTES = 256 * 1024;

export type FileHeadResultV1 =
  | {
    kind: "text";
    content: string;
    size: number;
    revision: string;
    lineCount: number;
    lineLimit: number;
    byteLimit: number;
    truncated: boolean;
  }
  | { kind: "binary"; size: number; revision: string };

export interface FileViewErrorV1 {
  code: "INVALID_REQUEST" | "CANCELLED" | "FILE_CHANGED" | "PERMISSION_DENIED" | "STALE_BINDING" | "READ_FAILED";
  message: string;
}

let requestSequence = 0;

export function createFileViewRequestId(): string {
  requestSequence += 1;
  return `head-${Date.now().toString(36)}-${requestSequence.toString(36)}`;
}

export function readFileHeadV1(
  resource: ResourceRef,
  lineLimit: number,
  requestId: string,
): Promise<FileHeadResultV1> {
  return readFileWindowV1(resource, lineLimit, requestId, "head");
}

export function readFileTailV1(
  resource: ResourceRef,
  lineLimit: number,
  requestId: string,
): Promise<FileHeadResultV1> {
  return readFileWindowV1(resource, lineLimit, requestId, "tail");
}

function readFileWindowV1(
  resource: ResourceRef,
  lineLimit: number,
  requestId: string,
  window: FileViewWindow,
): Promise<FileHeadResultV1> {
  if (!Number.isInteger(lineLimit) || lineLimit < 1 || lineLimit > MAX_FILE_HEAD_LINES || !isFileViewWindow(window)) {
    return Promise.reject({ code: "INVALID_REQUEST", message: "Invalid line limit" } satisfies FileViewErrorV1);
  }
  const command = resource.transport === "ssh"
    ? (window === "tail" ? "ssh_file_view_tail_v1" : "ssh_file_view_head_v1")
    : (window === "tail" ? "fs_file_view_tail_v1" : "fs_file_view_head_v1");
  if (resource.transport === "ssh") {
    if (!resource.binding || resource.binding.logicalSessionId !== resource.logicalSessionId) {
      return Promise.reject({ code: "STALE_BINDING", message: "Stale SSH binding" } satisfies FileViewErrorV1);
    }
    return invoke<FileHeadResultV1>(command, {
      binding: resource.binding,
      path: resource.path,
      lineLimit,
      requestId,
    });
  }
  return invoke<FileHeadResultV1>(command, {
    path: resource.path,
    lineLimit,
    requestId,
  });
}

export function cancelFileHeadViewV1(requestId: string): Promise<boolean> {
  return invoke<boolean>("fs_cancel_file_view_v1", { requestId });
}

export function parseFileViewError(error: unknown): FileViewErrorV1 {
  if (typeof error === "object" && error !== null && "code" in error && "message" in error) {
    return error as FileViewErrorV1;
  }
  return { code: "READ_FAILED", message: "The file could not be read." };
}
