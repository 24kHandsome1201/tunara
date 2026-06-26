import { invoke } from "@tauri-apps/api/core";
import type { DirEntry, ReadResult } from "@/modules/fs/fs-bridge";

/**
 * 远程 SFTP 文件操作。返回类型与本地 fs-bridge 完全一致，
 * 这样 FileExplorer 可以按 session.kind 切换数据源而无需改 UI。
 *
 * `id` 是后端 PTY/SSH 会话的物理 id（session.ptyId）。
 * 只读浏览 + 下载——没有远程写/编辑。
 */
export function sshReadDir(id: number, path: string, includeHidden = false): Promise<DirEntry[]> {
  return invoke<DirEntry[]>("ssh_fs_read_dir", { id, path, includeHidden });
}

export function sshReadFile(id: number, path: string): Promise<ReadResult> {
  return invoke<ReadResult>("ssh_fs_read_file", { id, path });
}

/** 解析远程 home 目录，作为文件面板初始路径。 */
export function sshHome(id: number): Promise<string> {
  return invoke<string>("ssh_fs_home", { id });
}

/** 下载远程文件到本地路径，返回写入字节数。 */
export function sshDownload(id: number, remotePath: string, localPath: string): Promise<number> {
  return invoke<number>("ssh_fs_download", { id, remotePath, localPath });
}
