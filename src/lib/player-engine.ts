let engine: Promise<void> | undefined;
export function loadPlayerEngine(): Promise<void> {
  engine ??= setup().catch((e) => {
    engine = undefined;
    throw e;
  });
  return engine;
}
async function setup() {
  if (
    !('adoptedStyleSheets' in Document.prototype) ||
    !('replaceSync' in CSSStyleSheet.prototype)
  ) {
    await import('construct-style-sheets-polyfill');
  }
  // Register only the components in Drift's skin; no bundled skins, embeds or analytics.
  await Promise.all([
    import('@videojs/html/video/player'),
    import('@videojs/html/ui/container'),
    import('@videojs/html/ui/controls'),
    import('@videojs/html/ui/controls-content'),
    import('@videojs/html/ui/controls-group'),
    import('@videojs/html/ui/play-button'),
    import('@videojs/html/ui/seek-button'),
    import('@videojs/html/ui/time-slider'),
    import('@videojs/html/ui/slider-track'),
    import('@videojs/html/ui/slider-buffer'),
    import('@videojs/html/ui/slider-fill'),
    import('@videojs/html/ui/slider-thumb'),
    import('@videojs/html/ui/time'),
    import('@videojs/html/ui/mute-button'),
    import('@videojs/html/ui/volume-slider'),
    import('@videojs/html/ui/fullscreen-button'),
    import('@videojs/html/ui/pip-button'),
    import('@videojs/html/ui/airplay-button'),
    import('@videojs/html/ui/status-announcer'),
  ]);
}
