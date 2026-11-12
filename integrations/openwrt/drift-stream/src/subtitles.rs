use crate::{Error, files, rpc::Torrent};
use std::{fmt::Write, path::Path};

pub const MAX_BYTES: u64 = 512 * 1024;
pub const MAX_OUTPUT: usize = 1024 * 1024;
pub const MAX_TRACKS: usize = 16;

pub struct Track {
    pub index: usize,
    pub label: String,
    pub language: String,
}

pub fn matching(torrent: &Torrent, video: usize) -> Vec<Track> {
    let Some(entry) = torrent.files.get(video) else {
        return vec![];
    };
    if files::media_type(&entry.name).is_none() {
        return vec![];
    }
    let path = Path::new(&entry.name);
    let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
        return vec![];
    };
    let stem = stem.to_lowercase();
    torrent
        .files
        .iter()
        .enumerate()
        .filter_map(|(index, file)| {
            let other = Path::new(&file.name);
            if file.length == 0
                || file.length > MAX_BYTES
                || other.parent() != path.parent()
                || !other
                    .extension()
                    .and_then(|s| s.to_str())
                    .is_some_and(|s| s.eq_ignore_ascii_case("srt") || s.eq_ignore_ascii_case("vtt"))
            {
                return None;
            }
            let name = other.file_stem()?.to_str()?.to_lowercase();
            let suffix = name.strip_prefix(&stem)?;
            if !suffix.is_empty() && !suffix.starts_with(['.', ' ', '_', '-']) {
                return None;
            }
            let label: String = suffix
                .trim_matches(['.', ' ', '_', '-'])
                .chars()
                .take(120)
                .collect();
            let tag = label.split(['.', ' ', '_']).next().unwrap_or("");
            let language = if !["sdh", "cc", "forced"].contains(&tag)
                && tag
                    .split('-')
                    .next()
                    .is_some_and(|s| (2..=3).contains(&s.len()))
                && tag.len() <= 35
                && tag.bytes().all(|b| b.is_ascii_alphabetic() || b == b'-')
            {
                tag.to_owned()
            } else {
                "und".to_owned()
            };
            Some(Track {
                index,
                label: if label.is_empty() {
                    "Subtitles".to_owned()
                } else {
                    label
                },
                language,
            })
        })
        .take(MAX_TRACKS)
        .collect()
}

fn timestamp(text: &str) -> Result<u64, Error> {
    let text = text.trim();
    let (whole, fraction) = text
        .rsplit_once([',', '.'])
        .ok_or("Invalid subtitle timestamp")?;
    if fraction.len() != 3 || !fraction.bytes().all(|b| b.is_ascii_digit()) {
        return Err("Invalid subtitle timestamp".into());
    }
    let mut parts = whole.rsplit(':');
    let number = |s: &str| -> Result<u64, Error> {
        if s.is_empty() || s.len() > 6 || !s.bytes().all(|b| b.is_ascii_digit()) {
            return Err("Invalid subtitle timestamp".into());
        }
        Ok(s.parse()?)
    };
    let seconds = number(parts.next().ok_or("Missing seconds")?)?;
    let minutes = number(parts.next().ok_or("Missing minutes")?)?;
    let hours = number(parts.next().unwrap_or("0"))?;
    if parts.next().is_some() || minutes >= 60 || seconds >= 60 {
        return Err("Invalid subtitle timestamp".into());
    }
    Ok(((hours * 60 + minutes) * 60 + seconds) * 1000 + number(fraction)?)
}

fn time(out: &mut String, milliseconds: u64) {
    let _ = write!(
        out,
        "{:02}:{:02}:{:02}.{:03}",
        milliseconds / 3_600_000,
        milliseconds / 60_000 % 60,
        milliseconds / 1000 % 60,
        milliseconds % 1000
    );
}

fn cue(out: &mut String, lines: &[&str]) -> Result<(), Error> {
    let timing = if lines[0].contains("-->") { 0 } else { 1 };
    let (start, end) = lines
        .get(timing)
        .and_then(|s| s.split_once("-->"))
        .ok_or("Invalid subtitle cue")?;
    let start = timestamp(start)?;
    // WebVTT position/region/style settings are deliberately not carried through.
    let end = timestamp(end.split_whitespace().next().ok_or("Missing end time")?)?;
    if end <= start || lines.len() <= timing + 1 {
        return Err("Invalid subtitle cue".into());
    }
    time(out, start);
    out.push_str(" --> ");
    time(out, end);
    out.push('\n');
    for line in &lines[timing + 1..] {
        if line.len() > 8192 {
            return Err("Subtitle line too long".into());
        }
        let mut rest = *line;
        while !rest.is_empty() {
            if let Some(entity) = ["&amp;", "&lt;", "&gt;", "&nbsp;", "&lrm;", "&rlm;"]
                .into_iter()
                .find(|s| rest.starts_with(s))
            {
                out.push_str(entity);
                rest = &rest[entity.len()..];
                continue;
            }
            if let Some(tag) = ["<b>", "</b>", "<i>", "</i>", "<u>", "</u>"]
                .into_iter()
                .find(|tag| rest.starts_with(tag))
            {
                out.push_str(tag);
                rest = &rest[tag.len()..];
                continue;
            }
            let ch = rest.chars().next().ok_or("Invalid text")?;
            match ch {
                '&' => out.push_str("&amp;"),
                '<' => out.push_str("&lt;"),
                '>' => out.push_str("&gt;"),
                ch if ch.is_control() && ch != '\t' => {}
                ch => out.push(ch),
            }
            rest = &rest[ch.len_utf8()..];
        }
        out.push('\n');
    }
    out.push('\n');
    if out.len() > MAX_OUTPUT {
        return Err("Subtitle output too large".into());
    }
    Ok(())
}

pub fn convert(bytes: &[u8]) -> Result<String, Error> {
    if bytes.len() as u64 > MAX_BYTES {
        return Err("Subtitle too large".into());
    }
    let text = if bytes.starts_with(&[0xff, 0xfe]) || bytes.starts_with(&[0xfe, 0xff]) {
        if bytes.len() % 2 != 0 {
            return Err("Invalid UTF-16 subtitle".into());
        }
        let little = bytes[0] == 0xff;
        let units = bytes[2..]
            .chunks_exact(2)
            .map(|b| {
                if little {
                    u16::from_le_bytes([b[0], b[1]])
                } else {
                    u16::from_be_bytes([b[0], b[1]])
                }
            })
            .collect::<Vec<_>>();
        String::from_utf16(&units)?
    } else {
        std::str::from_utf8(bytes)?
            .trim_start_matches('\u{feff}')
            .to_owned()
    };
    if text.len() > MAX_OUTPUT || text.contains('\0') {
        return Err("Invalid subtitle text".into());
    }
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    let webvtt = text.starts_with("WEBVTT");
    let mut out = String::from("WEBVTT\n\n");
    let mut block = Vec::new();
    let mut count = 0;
    for line in text.lines().chain(std::iter::once("")) {
        if !line.trim().is_empty() {
            if block.len() >= 64 {
                return Err("Subtitle cue too large".into());
            }
            block.push(line);
        } else if !block.is_empty() {
            let head = block[0];
            if !(webvtt
                && (head.starts_with("WEBVTT")
                    || head == "STYLE"
                    || head == "REGION"
                    || head == "NOTE"
                    || head.starts_with("NOTE ")))
            {
                cue(&mut out, &block)?;
                count += 1;
                if count > 10000 {
                    return Err("Too many subtitle cues".into());
                }
            }
            block.clear();
        }
    }
    if count == 0 {
        return Err("No subtitle cues".into());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_srt_and_utf16_and_removes_active_markup() {
        let srt = "1\r\n00:00:01,050 --> 00:00:02,100\r\n<i>Hello</i> <script>alert(1)</script> & goodbye\r\n";
        let expected = "WEBVTT\n\n00:00:01.050 --> 00:00:02.100\n<i>Hello</i> &lt;script&gt;alert(1)&lt;/script&gt; &amp; goodbye\n\n";
        assert_eq!(convert(srt.as_bytes()).unwrap(), expected);
        let bytes: Vec<u8> = [0xff, 0xfe]
            .into_iter()
            .chain(srt.encode_utf16().flat_map(u16::to_le_bytes))
            .collect();
        assert_eq!(convert(&bytes).unwrap(), expected);
        assert!(convert(b"<html>arbitrary download</html>").is_err());
        assert!(convert(b"1\n00:99:00,000 --> 00:00:01,000\nBad").is_err());
        assert!(convert(&vec![b'a'; MAX_BYTES as usize + 1]).is_err());
    }

    #[test]
    fn vtt_uses_only_cues_and_matching_is_episode_and_directory_scoped() {
        let vtt = b"WEBVTT\n\nSTYLE\n::cue { background: url(https://example.test); }\n\n00:01.000 --> 00:02.000 align:start\nHello\n";
        assert_eq!(
            convert(vtt).unwrap(),
            "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\n\n"
        );
        let torrent: Torrent = serde_json::from_value(serde_json::json!({"hashString":"a".repeat(40),"downloadDir":"/data","pieceSize":65536,"pieceCount":1,"pieces":"gA==","status":0,"files":[{"name":"show/episode1.mp4","length":100},{"name":"show/episode1.en.srt","length":100},{"name":"show/episode10.en.srt","length":100},{"name":"other/episode1.en.srt","length":100},{"name":"show/episode1.vtt","length":100},{"name":"show/episode1.en.srt","length":MAX_BYTES+1}]})).unwrap();
        let tracks = matching(&torrent, 0);
        assert_eq!(tracks.iter().map(|t| t.index).collect::<Vec<_>>(), [1, 4]);
        assert_eq!(tracks[0].language, "en");
    }
}
