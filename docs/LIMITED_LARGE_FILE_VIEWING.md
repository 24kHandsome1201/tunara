# Limited large text and log viewing

Tunara keeps the existing complete preview/editor path for small UTF-8 files. When that path reports a truncated or oversized file, the file surface offers an explicit, read-only **View beginning** or **View end** action, similar to `head -n N` / `tail -n N`.

## User contract

- Safe presets are 100, 500, 1,000 (default), and 2,000 lines.
- The window can be the start or the end of the file. Switching windows does not download the rest of the file.
- Results are rendered as one multiline `<pre>` text node rather than one DOM node per line. JSON, CSV, and TSV that parse as tables are shown as read-only text cells (no HTML).
- The user can cancel an active request. A changed file, stale SSH session, binary input, permission failure, and generic read failure have separate UI states.
- The result is a snapshot of one revision. If size or modification time changes while reading, Tunara rejects the result and asks the user to retry.
- While the preview stays in the foreground and the draft is clean, Tunara refreshes the same bounded window about every 2.5 seconds and skips a DOM update when the revision is unchanged.

## IPC and limits

The versioned commands are:

- `fs_file_view_head_v1(path, lineLimit, requestId)` for the start of a local file;
- `fs_file_view_tail_v1(path, lineLimit, requestId)` for the end of a local file;
- `ssh_file_view_head_v1(binding, path, lineLimit, requestId)` for the start of an SFTP file;
- `ssh_file_view_tail_v1(binding, path, lineLimit, requestId)` for the end of an SFTP file;
- `fs_cancel_file_view_v1(requestId)` for either transport.

The frontend dispatches these commands from a `ResourceRef`. SSH requests include the complete backend-issued `SessionBindingV1`; the backend validates logical session id, physical PTY id, and transport generation before opening SFTP.

Every request has server-enforced hard limits of **2,000 lines** and **256 KiB**, read in **16 KiB chunks**. Tail reads seek to the last 256 KiB rather than scanning the whole file. These limits apply even if metadata under-reports file size. The implementation never routes through download/transfer APIs and never reads the whole file before truncating. The existing SFTP preview path is also capped at 256 KiB so merely opening a large file cannot pre-read 10 MiB before the user chooses this action.

The reader preserves UTF-8 sequences across transport chunk boundaries, trims only an incomplete sequence at the byte ceiling, rejects invalid internal UTF-8 or NUL-sniffed content as binary, and bounds a single overlong line at the byte ceiling. Typed errors expose fixed safe messages; raw local paths, SFTP status details, and credentials are not returned over IPC.

SVG, PDF, and video are out of scope. SVG remains an explicit preview rejection.
