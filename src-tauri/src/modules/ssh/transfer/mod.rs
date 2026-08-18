pub mod engine;
pub mod legacy;
pub mod manifest;
pub mod upload_plan;

use crate::modules::ssh::remote_fs::RemotePathKindV1;

/// POSIX/SFTP file-type bits as protocol `u32` values.
///
/// SFTP attributes report permissions as `u32`. libc's `S_IF*` constants are
/// `mode_t` (`u16` on macOS, `u32` on Linux), so matching those host types
/// against remote attributes fails to type-check on Darwin. The numeric
/// values are the POSIX file-type bits used by both SFTP and Unix hosts.
pub(crate) const S_IFMT: u32 = 0o170_000;
pub(crate) const S_IFREG: u32 = 0o100_000;
pub(crate) const S_IFDIR: u32 = 0o040_000;
pub(crate) const S_IFLNK: u32 = 0o120_000;

pub(crate) fn remote_kind_from_unix_mode(mode: u32) -> Option<RemotePathKindV1> {
    match mode & S_IFMT {
        S_IFREG => Some(RemotePathKindV1::File),
        S_IFDIR => Some(RemotePathKindV1::Directory),
        S_IFLNK => Some(RemotePathKindV1::Symlink),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_sftp_permission_bits_as_protocol_u32() {
        assert_eq!(
            remote_kind_from_unix_mode(S_IFREG | 0o644),
            Some(RemotePathKindV1::File)
        );
        assert_eq!(
            remote_kind_from_unix_mode(S_IFDIR | 0o755),
            Some(RemotePathKindV1::Directory)
        );
        assert_eq!(
            remote_kind_from_unix_mode(S_IFLNK | 0o777),
            Some(RemotePathKindV1::Symlink)
        );
        assert_eq!(remote_kind_from_unix_mode(0), None);
        assert_eq!(remote_kind_from_unix_mode(0o150_000), None);
        // High bits that would not fit in macOS `mode_t` (`u16`).
        assert_eq!(
            remote_kind_from_unix_mode(0x8000_0000 | S_IFREG),
            Some(RemotePathKindV1::File)
        );
    }
}
