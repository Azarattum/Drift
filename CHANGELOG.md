# Changelog

Notable changes follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Release tags and web/native package versions use the same semantic version.

## [Unreleased]

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
