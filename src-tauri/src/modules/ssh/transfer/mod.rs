pub mod engine;
pub mod legacy;
pub mod manifest;
pub mod upload_plan;

use crate::modules::ssh::remote_fs::RemotePathKindV1;

/// libc file-type bits are `mode_t`: `u32` on Linux, `u16` on macOS.
fn unix_file_type(mode: u32) -> u32 {
    mode & (libc::S_IFMT as u32)
}

fn remote_kind_from_unix_mode(mode: u32) -> Option<RemotePathKindV1> {
    match unix_file_type(mode) {
        ty if ty == libc::S_IFREG as u32 => Some(RemotePathKindV1::File),
        ty if ty == libc::S_IFDIR as u32 => Some(RemotePathKindV1::Directory),
        ty if ty == libc::S_IFLNK as u32 => Some(RemotePathKindV1::Symlink),
        _ => None,
    }
}
