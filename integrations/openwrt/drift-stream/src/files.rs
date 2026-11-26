use base64::{Engine, engine::general_purpose::STANDARD};
use rustix::fs::{Mode, OFlags, openat};
use std::{
    fs::File,
    io,
    os::unix::fs::{FileExt, MetadataExt},
    path::{Component, Path, PathBuf},
};

use crate::{Error, rpc::Torrent};

pub struct Root {
    pub path: PathBuf,
    directory: File,
}
impl Root {
    pub fn open(path: &Path) -> Result<Self, Error> {
        let directory = File::open(path)?;
        if !directory.metadata()?.is_dir() {
            return Err("Download root is not a directory".into());
        }
        Ok(Self {
            path: path.to_owned(),
            directory,
        })
    }
    pub fn file(&self, relative: &Path) -> io::Result<File> {
        self.open_file(relative, false)
    }
    fn open_file(&self, relative: &Path, writable: bool) -> io::Result<File> {
        if relative.as_os_str().is_empty()
            || !relative
                .components()
                .all(|p| matches!(p, Component::Normal(_)))
        {
            return Err(io::Error::from(io::ErrorKind::PermissionDenied));
        }
        let mut directory = self.directory.try_clone()?;
        let mut parts = relative.components().peekable();
        while let Some(part) = parts.next() {
            let access = if writable && parts.peek().is_none() {
                OFlags::RDWR
            } else {
                OFlags::RDONLY
            };
            let flags = access | OFlags::CLOEXEC | OFlags::NOFOLLOW | OFlags::NONBLOCK;
            let flags = if parts.peek().is_some() {
                flags | OFlags::DIRECTORY
            } else {
                flags
            };
            directory = openat(&directory, part.as_os_str(), flags, Mode::empty())?.into();
        }
        let meta = directory.metadata()?;
        if !meta.is_file() || meta.nlink() != 1 {
            return Err(io::Error::from(io::ErrorKind::PermissionDenied));
        }
        Ok(directory)
    }
}

pub fn media_type(name: &str) -> Option<&'static str> {
    match Path::new(name)
        .extension()?
        .to_str()?
        .to_ascii_lowercase()
        .as_str()
    {
        "mp4" | "m4v" => Some("video/mp4"),
        "mov" => Some("video/quicktime"),
        "mkv" => Some("video/x-matroska"),
        "webm" => Some("video/webm"),
        "avi" => Some("video/x-msvideo"),
        "ts" | "m2ts" | "mts" => Some("video/mp2t"),
        _ => None,
    }
}

pub fn matches_container(mime: &str, bytes: &[u8]) -> bool {
    match mime {
        "video/mp4" | "video/quicktime" => bytes
            .get(4..8)
            .is_some_and(|v| [b"ftyp".as_slice(), b"moov", b"wide"].contains(&v)),
        "video/webm" | "video/x-matroska" => bytes.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]),
        "video/x-msvideo" => bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"AVI "),
        "video/mp2t" => {
            (bytes.first() == Some(&0x47) && bytes.get(188) == Some(&0x47))
                || (bytes.get(4) == Some(&0x47) && bytes.get(196) == Some(&0x47))
        }
        _ => false,
    }
}

pub fn open_media(roots: &[Root], torrent: &Torrent, index: usize) -> Result<File, Error> {
    let entry = torrent.files.get(index).ok_or("Unknown file")?;
    if media_type(&entry.name).is_none() {
        return Err("Not an allowed video container".into());
    }
    open_torrent_file(roots, torrent, index)
}

pub(crate) fn open_torrent_file(
    roots: &[Root],
    torrent: &Torrent,
    index: usize,
) -> Result<File, Error> {
    find_torrent_file(roots, torrent, index, false)
}

fn find_torrent_file(
    roots: &[Root],
    torrent: &Torrent,
    index: usize,
    writable: bool,
) -> Result<File, Error> {
    let entry = torrent.files.get(index).ok_or("Unknown file")?;
    let name = Path::new(&entry.name);
    // Explicit raw segments also reject '.' which Path::components normalizes away.
    if entry
        .name
        .split('/')
        .any(|s| s.is_empty() || s == "." || s == "..")
        || entry.name.contains(['\\', '\0'])
    {
        return Err("Invalid torrent path".into());
    }
    for root in roots {
        let download = Path::new(&torrent.download_dir);
        let relative = if download == root.path {
            name.to_owned()
        } else if let Ok(subdir) = download.strip_prefix(&root.path) {
            subdir.join(name)
        } else {
            continue;
        };
        for candidate in [
            relative.clone(),
            PathBuf::from(format!("{}.part", relative.display())),
        ] {
            match root.open_file(&candidate, writable) {
                Ok(file) => return Ok(file),
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.into()),
            }
        }
    }
    // Incomplete roots store the torrent-relative filename, regardless of downloadDir.
    for root in roots.iter().skip(1) {
        for candidate in [
            name.to_owned(),
            PathBuf::from(format!("{}.part", entry.name)),
        ] {
            match root.open_file(&candidate, writable) {
                Ok(file) => return Ok(file),
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.into()),
            }
        }
    }
    Err("Video data is not available in the inherited roots".into())
}

/// Return the part of the file covered exclusively by its own torrent pieces.
pub fn exclusive_range(torrent: &Torrent, index: usize) -> Option<(u64, u64)> {
    let piece = torrent.piece_size;
    if piece == 0 {
        return None;
    }
    let offset = torrent
        .files
        .get(..index)?
        .iter()
        .try_fold(0u64, |sum, file| sum.checked_add(file.length))?;
    let length = torrent.files.get(index)?.length;
    let end = offset.checked_add(length)?;
    let start = offset.div_ceil(piece).checked_mul(piece)?;
    let exclusive_end = if torrent.files[index + 1..]
        .iter()
        .all(|file| file.length == 0)
    {
        end
    } else {
        end / piece * piece
    };
    (exclusive_end > start).then(|| (start - offset, exclusive_end - start))
}

pub fn open_discard_file(roots: &[Root], torrent: &Torrent, index: usize) -> Result<File, Error> {
    find_torrent_file(roots, torrent, index, true)
}

#[cfg(target_os = "linux")]
pub fn discard_data(file: &File, offset: u64, length: u64) -> io::Result<()> {
    use rustix::fs::{FallocateFlags, fallocate};
    fallocate(
        file,
        FallocateFlags::PUNCH_HOLE | FallocateFlags::KEEP_SIZE,
        offset,
        length,
    )?;
    Ok(())
}

#[cfg(not(target_os = "linux"))]
pub fn discard_data(_file: &File, _offset: u64, _length: u64) -> io::Result<()> {
    Err(io::ErrorKind::Unsupported.into())
}

pub fn read_at(file: &File, position: u64, len: usize) -> io::Result<Vec<u8>> {
    let mut buffer = vec![0; len];
    let mut read = 0;
    while read < len {
        match file.read_at(&mut buffer[read..], position + read as u64) {
            Ok(0) => return Err(io::ErrorKind::UnexpectedEof.into()),
            Ok(n) => read += n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    Ok(buffer)
}

pub fn decode_pieces(encoded: &str, count: u64) -> Result<Vec<u8>, Error> {
    if count == 0 || count > 16_777_216 {
        return Err("Invalid piece count".into());
    }
    let bits = STANDARD.decode(encoded)?;
    if bits.len() as u64 != count.div_ceil(8) {
        return Err("Invalid piece bitfield".into());
    }
    Ok(bits)
}

pub fn verified_end(bits: &[u8], piece_size: u64, absolute: u64, end: u64) -> u64 {
    if piece_size == 0 {
        return absolute;
    }
    let mut cursor = absolute;
    while cursor < end {
        let piece = cursor / piece_size;
        if bits
            .get((piece / 8) as usize)
            .is_none_or(|byte| byte & (0x80 >> (piece % 8)) == 0)
        {
            break;
        }
        cursor = end.min(piece.saturating_add(1).saturating_mul(piece_size));
    }
    cursor
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn holes_and_unaligned_file_boundaries() {
        assert_eq!(verified_end(&[0b10110000], 100, 30, 400), 100);
        assert_eq!(verified_end(&[0b10110000], 100, 100, 400), 100);
        assert_eq!(verified_end(&[0b10110000], 100, 220, 350), 350);
        assert_eq!(verified_end(&[], 100, 0, 400), 0);
        assert!(decode_pieces("gA==", 9).is_err());
    }
    #[test]
    fn refuses_symlink_hardlink_directory_and_traversal() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::NamedTempFile::new().unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("escape.mp4")).unwrap();
        std::os::unix::fs::symlink(outside.path().parent().unwrap(), dir.path().join("escape"))
            .unwrap();
        std::fs::write(dir.path().join("safe.mp4"), b"video").unwrap();
        std::fs::hard_link(dir.path().join("safe.mp4"), dir.path().join("hard.mp4")).unwrap();
        let root = Root::open(dir.path()).unwrap();
        for name in [
            "escape.mp4",
            "escape/file.mp4",
            "hard.mp4",
            "../file.mp4",
            "/etc/passwd",
        ] {
            assert!(root.file(Path::new(name)).is_err(), "{name}");
        }
        assert!(media_type("settings.json").is_none());
        assert!(!matches_container("video/mp4", b"<html>secret</html>"));
    }
}
