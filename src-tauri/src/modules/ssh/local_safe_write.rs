//! Hardened local atomic replacement. This is deliberately independent from
//! the SFTP `safe_write` module: local pathname and ownership guarantees are
//! different security primitives.

use sha2::{Digest, Sha256};
use std::fmt;
use std::path::Path;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Revision {
    Missing,
    Content(String),
}

#[derive(Debug)]
pub enum Error {
    Io(std::io::Error),
    /// The rename committed, but syncing the containing directory failed.
    /// Callers must not report this as a pre-commit failure or retry blindly.
    DurabilityUnknown(std::io::Error),
    Unsafe(String),
    Conflict,
    #[cfg(not(unix))]
    Unsupported,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(e) => write!(f, "local safe write failed: {e}"),
            Self::DurabilityUnknown(e) => {
                write!(
                    f,
                    "local safe write committed but durability is unknown: {e}"
                )
            }
            Self::Unsafe(s) => write!(f, "unsafe local path: {s}"),
            Self::Conflict => f.write_str("local safe write conflict"),
            #[cfg(not(unix))]
            Self::Unsupported => f.write_str("local safe write unsupported on this platform"),
        }
    }
}
impl std::error::Error for Error {}
impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e)
    }
}

pub fn revision(bytes: &[u8]) -> Revision {
    Revision::Content(format!("{:x}", Sha256::digest(bytes)))
}

#[cfg(unix)]
mod unix {
    use super::*;
    use getrandom::fill;
    use std::ffi::{CStr, CString};
    use std::fs::{self, File, OpenOptions};
    use std::io::{Read, Write};
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
    use std::path::Component;

    fn owner_controlled(meta: &fs::Metadata) -> bool {
        meta.uid() == unsafe { libc::geteuid() } && meta.mode() & 0o022 == 0
    }

    fn relative_name(path: &Path) -> Result<CString, Error> {
        let name = path
            .file_name()
            .ok_or_else(|| Error::Unsafe("target has no file name".into()))?;
        CString::new(name.as_bytes())
            .map_err(|_| Error::Unsafe("target file name contains NUL".into()))
    }

    fn open_parent(path: &Path, create: bool) -> Result<File, Error> {
        let parent = path
            .parent()
            .ok_or_else(|| Error::Unsafe("target has no parent".into()))?;
        let mut dir = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
            .open(if parent.is_absolute() {
                Path::new("/")
            } else {
                Path::new(".")
            })?;
        for component in parent.components() {
            let Component::Normal(component) = component else {
                if matches!(component, Component::RootDir | Component::CurDir) {
                    continue;
                }
                return Err(Error::Unsafe(
                    "parent path contains unsupported components".into(),
                ));
            };
            let name = CString::new(component.as_bytes())
                .map_err(|_| Error::Unsafe("parent component contains NUL".into()))?;
            let mut fd = unsafe {
                libc::openat(
                    dir.as_raw_fd(),
                    name.as_ptr(),
                    libc::O_RDONLY | libc::O_CLOEXEC | libc::O_DIRECTORY | libc::O_NOFOLLOW,
                )
            };
            if fd < 0
                && create
                && std::io::Error::last_os_error().raw_os_error() == Some(libc::ENOENT)
            {
                let created = unsafe { libc::mkdirat(dir.as_raw_fd(), name.as_ptr(), 0o700) };
                if created != 0
                    && std::io::Error::last_os_error().raw_os_error() != Some(libc::EEXIST)
                {
                    return Err(std::io::Error::last_os_error().into());
                }
                fd = unsafe {
                    libc::openat(
                        dir.as_raw_fd(),
                        name.as_ptr(),
                        libc::O_RDONLY | libc::O_CLOEXEC | libc::O_DIRECTORY | libc::O_NOFOLLOW,
                    )
                };
            }
            if fd < 0 {
                let error = std::io::Error::last_os_error();
                return match error.raw_os_error() {
                    Some(libc::ELOOP) => Err(Error::Unsafe(
                        "parent path must not contain symlinks".into(),
                    )),
                    // macOS reports O_NOFOLLOW|O_DIRECTORY on a symlink as
                    // ENOTDIR (the symlink inode is not a directory) rather
                    // than ELOOP. A regular file in the parent chain is also
                    // ENOTDIR and equally unsafe to treat as a directory.
                    Some(libc::ENOTDIR) => {
                        Err(Error::Unsafe("parent path must be a directory".into()))
                    }
                    _ => Err(error.into()),
                };
            }
            dir = unsafe { File::from_raw_fd(fd) };
        }
        let metadata = dir.metadata()?;
        if !metadata.file_type().is_dir() || !owner_controlled(&metadata) {
            return Err(Error::Unsafe(
                "parent must be an owner-controlled, non-writable-by-others directory".into(),
            ));
        }
        Ok(dir)
    }

    fn read_at(dir: &File, name: &CStr) -> Result<Option<Vec<u8>>, Error> {
        let fd = unsafe {
            libc::openat(
                dir.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK,
            )
        };
        if fd < 0 {
            let error = std::io::Error::last_os_error();
            return match error.raw_os_error() {
                Some(libc::ENOENT) => Ok(None),
                Some(libc::ELOOP) => Err(Error::Unsafe("target must not be a symlink".into())),
                _ => Err(error.into()),
            };
        }
        let mut file = unsafe { File::from_raw_fd(fd) };
        let opened = file.metadata()?;
        if !opened.file_type().is_file() || !owner_controlled(&opened) {
            return Err(Error::Unsafe(
                "target must be an owner-controlled regular file not writable by others".into(),
            ));
        }
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)?;
        Ok(Some(bytes))
    }

    fn inspect_at(dir: &File, name: &CStr) -> Result<Revision, Error> {
        Ok(match read_at(dir, name)? {
            Some(bytes) => revision(&bytes),
            None => Revision::Missing,
        })
    }

    fn create_temp_at(dir: &File, name: &CStr) -> Result<File, std::io::Error> {
        let fd = unsafe {
            libc::openat(
                dir.as_raw_fd(),
                name.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_CLOEXEC | libc::O_NOFOLLOW,
                0o600,
            )
        };
        if fd < 0 {
            Err(std::io::Error::last_os_error())
        } else {
            Ok(unsafe { File::from_raw_fd(fd) })
        }
    }

    fn unlink_at(dir: &File, name: &CStr) {
        unsafe {
            libc::unlinkat(dir.as_raw_fd(), name.as_ptr(), 0);
        }
    }

    fn verify_temp_identity(dir: &File, name: &CStr, original: &File) -> Result<(), Error> {
        let fd = unsafe {
            libc::openat(
                dir.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK,
            )
        };
        if fd < 0 {
            return Err(Error::Unsafe("temporary file pathname was replaced".into()));
        }
        let reopened = unsafe { File::from_raw_fd(fd) };
        let expected = original.metadata()?;
        let actual = reopened.metadata()?;
        if !actual.file_type().is_file()
            || !owner_controlled(&actual)
            || actual.dev() != expected.dev()
            || actual.ino() != expected.ino()
        {
            return Err(Error::Unsafe("temporary file identity changed".into()));
        }
        Ok(())
    }

    pub fn ensure_parent(path: &Path) -> Result<(), Error> {
        open_parent(path, true).map(drop)
    }

    pub fn read(path: &Path) -> Result<Option<Vec<u8>>, Error> {
        let dir = open_parent(path, false)?;
        let target_name = relative_name(path)?;
        read_at(&dir, &target_name)
    }

    pub fn replace(path: &Path, bytes: &[u8], expected: &Revision) -> Result<(), Error> {
        // Every parent component is opened relative to the preceding verified
        // directory descriptor with O_NOFOLLOW. All subsequent operations stay
        // relative to this single authoritative descriptor.
        let dir = open_parent(path, false)?;
        let target_name = relative_name(path)?;
        if &inspect_at(&dir, &target_name)? != expected {
            return Err(Error::Conflict);
        }

        let mut random = [0u8; 16];
        let mut created: Option<(CString, File)> = None;
        for _ in 0..32 {
            fill(&mut random).map_err(|e| {
                Error::Io(std::io::Error::other(format!("secure random failed: {e}")))
            })?;
            let name = format!(".tunara-{:x}.tmp", u128::from_ne_bytes(random));
            let temp_name = CString::new(name).expect("generated temp name contains no NUL");
            match create_temp_at(&dir, &temp_name) {
                Ok(file) => {
                    created = Some((temp_name, file));
                    break;
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(e.into()),
            }
        }
        let (temp_name, mut file) = created.ok_or_else(|| {
            Error::Io(std::io::Error::new(
                std::io::ErrorKind::AlreadyExists,
                "could not allocate random temporary file",
            ))
        })?;
        let result = (|| {
            let tm = file.metadata()?;
            if !tm.file_type().is_file() || !owner_controlled(&tm) {
                return Err(Error::Unsafe(
                    "temporary file ownership/type changed".into(),
                ));
            }
            file.set_permissions(fs::Permissions::from_mode(0o600))?;
            file.write_all(bytes)?;
            file.flush()?;
            file.sync_all()?;
            // Recheck immediately before replacement, catching external edits
            // that happened while the replacement was prepared.
            if &inspect_at(&dir, &target_name)? != expected {
                return Err(Error::Conflict);
            }
            verify_temp_identity(&dir, &temp_name, &file)?;
            let renamed = unsafe {
                libc::renameat(
                    dir.as_raw_fd(),
                    temp_name.as_ptr(),
                    dir.as_raw_fd(),
                    target_name.as_ptr(),
                )
            };
            if renamed != 0 {
                return Err(std::io::Error::last_os_error().into());
            }
            dir.sync_all().map_err(Error::DurabilityUnknown)?;
            Ok(())
        })();
        if result.is_err() {
            unlink_at(&dir, &temp_name);
        }
        result
    }
}

#[cfg(unix)]
pub use unix::{ensure_parent, read, replace};

#[cfg(not(unix))]
pub fn replace(_path: &Path, _bytes: &[u8], _expected: &Revision) -> Result<(), Error> {
    Err(Error::Unsupported)
}

#[cfg(not(unix))]
pub fn read(_path: &Path) -> Result<Option<Vec<u8>>, Error> {
    Err(Error::Unsupported)
}

#[cfg(not(unix))]
pub fn ensure_parent(_path: &Path) -> Result<(), Error> {
    Err(Error::Unsupported)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::ffi::CString;
    use std::fs;
    use std::os::unix::fs::{symlink, PermissionsExt};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn physical_temp_dir() -> std::path::PathBuf {
        // Walk from `/` with O_NOFOLLOW, so fixtures cannot live under a
        // symlink component. macOS `/tmp` and `/var` are such links.
        fs::canonicalize(std::env::temp_dir()).unwrap_or_else(|_| std::env::temp_dir())
    }

    fn fixture() -> std::path::PathBuf {
        let p = physical_temp_dir().join(format!(
            "tunara-local-write-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&p).unwrap();
        p
    }

    #[test]
    fn atomic_content_mode_and_cas() {
        let dir = fixture();
        let path = dir.join("store");
        replace(&path, b"one", &Revision::Missing).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"one");
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let old = revision(b"one");
        fs::write(&path, b"external").unwrap();
        assert!(matches!(replace(&path, b"two", &old), Err(Error::Conflict)));
        assert_eq!(fs::read(&path).unwrap(), b"external");
        assert!(fs::read_dir(&dir).unwrap().all(|e| !e
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(".tmp")));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn rejects_target_and_parent_symlinks() {
        let dir = fixture();
        let real = dir.join("real");
        fs::write(&real, b"x").unwrap();
        let link = dir.join("link");
        symlink(&real, &link).unwrap();
        assert!(
            read(&link).is_err(),
            "safe reads must not follow target symlinks"
        );
        assert!(matches!(
            replace(&link, b"bad", &revision(b"x")),
            Err(Error::Unsafe(_))
        ));
        let parent_link = dir.with_extension("link");
        symlink(&dir, &parent_link).unwrap();
        assert!(replace(&parent_link.join("new"), b"bad", &Revision::Missing).is_err());
        fs::remove_file(parent_link).unwrap();
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn rejects_writable_by_others_paths_and_non_regular_targets() {
        use std::os::unix::ffi::OsStrExt;

        let dir = fixture();
        let target = dir.join("store");
        fs::write(&target, b"one").unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o666)).unwrap();
        assert!(matches!(read(&target), Err(Error::Unsafe(_))));

        fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o777)).unwrap();
        assert!(matches!(read(&target), Err(Error::Unsafe(_))));
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();

        let fifo = dir.join("fifo");
        let fifo_name = CString::new(fifo.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo_name.as_ptr(), 0o600) }, 0);
        assert!(matches!(read(&fifo), Err(Error::Unsafe(_))));

        let nested = dir.join("new").join("private").join("store");
        ensure_parent(&nested).unwrap();
        assert_eq!(
            fs::metadata(nested.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        fs::remove_dir_all(dir).unwrap();
    }
}
