pub mod engine;
pub mod legacy;
pub mod manifest;
pub mod upload_plan;

use crate::modules::ssh::remote_fs::RemotePathKindV1;

/// libc file-type bits are `mode_t`: `u32` on Linux, `u16` on macOS.
#[allow(clippy::unnecessary_cast)]
const fn unix_mode_u32(bits: libc::mode_t) -> u32 {
    bits as u32
}

fn unix_file_type(mode: u32) -> u32 {
    mode & unix_mode_u32(libc::S_IFMT)
}

fn remote_kind_from_unix_mode(mode: u32) -> Option<RemotePathKindV1> {
    match unix_file_type(mode) {
        ty if ty == unix_mode_u32(libc::S_IFREG) => Some(RemotePathKindV1::File),
        ty if ty == unix_mode_u32(libc::S_IFDIR) => Some(RemotePathKindV1::Directory),
        ty if ty == unix_mode_u32(libc::S_IFLNK) => Some(RemotePathKindV1::Symlink),
        _ => None,
    }
}
