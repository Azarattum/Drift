# Changelog

Notable changes follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Release tags and web/native package versions use the same semantic version.

## [Unreleased]

## [0.3.1] - 2026-11-26

### Fixed

- Keep the cursor visible when hovering over the fullscreen button.

## [0.3.0] - 2026-11-26

### Added

- Delete downloaded data for a single file from the inspector or player when using the updated Linux companion. The action unchecks the file, keeps pieces shared with neighboring files, and resumes active torrents after verification.
- Show per-file download progress and provide download priority and selection actions in the video file list.
- Switch compatible Matroska audio tracks over HTTP and select embedded SubRip subtitles alongside sidecar captions while a torrent downloads.

### Changed

- Use a single player header with the filename above the torrent name and download status.

### Fixed

- Keep the player size steady while browsing files, switching videos, or choosing whether to resume playback.
- Keep playback controls and file menus reachable on narrow screens, including phones in landscape.
- Dismiss the subtitle menu when clicking outside it and hide the idle cursor after fullscreen keyboard shortcuts.

## [0.2.0] - 2026-11-26

### Added

- Choose audio tracks during playback when the browser or Drift's decoder exposes multiple tracks.

### Changed

- Align the Next video and Files actions. Open the file list beside the player on desktop and above it on mobile.
- Use the torrent name as the video chooser title and distinguish the collection from individual videos with folder and film icons.

### Known limitations

- The fallback decoder can ignore an audio track selection on some Matroska files. On plain HTTP, audio track selection depends on browser support.

## [0.1.3] - 2026-11-13

### Fixed

- Measure seek controls relative to the playback position and avoid competing browser decoders on release runners.
- Retain browser failure traces in GitHub Actions.

## [0.1.2] - 2026-11-13

### Fixed

- Isolate playback recovery and daemon-version tests from background seeks and requests.

## [0.1.1] - 2026-11-13

### Fixed

- Align batch actions with transfer rows when the system reserves space for scrollbars.
- Make playback recovery and saved-volume checks work across browser buffering and floating-point differences.

## [0.1.0] - 2026-11-13

### Added

- Static Transmission web client with desktop and mobile layouts, themes, batch transfer actions, file selection, peer inspection, and activity charts.
- Optional OpenWrt streaming companion with browser playback, saved positions, matching SRT/WebVTT subtitles, and missing-range scheduling requests.
- Optional router bandwidth control, Full speed overrides, activity history, and tracker VPN fallback.
- Tag-triggered releases with prebuilt web files, ARM64 and x86-64 Linux companions, OpenWrt helpers, and SHA-256 checksums.

### Fixed

- Connection changes cancel old RPC requests and reject stale responses, preventing retries or transfer actions from targeting the wrong server.
- Switching Full speed between torrents preserves their original bandwidth limits.
- RPC requests retain their timeout when a caller supplies a cancellation signal.
- Stream recovery now expires stale download-wait state, renews retries after playback progresses, and preserves selected captions and playback speed.
- Bandwidth diagram corners are transparent instead of white.

### Known limitations

- Browser codecs determine playable formats; the companion does not transcode.
- Transmission's sequential cursor is not a strict piece priority. Real swarms may still delay required pieces until near completion, even with a high download percentage.
