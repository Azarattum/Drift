// Capture the native capability before loading the polyfill. Safari 15.4's dialog
// has animation and background-SVG interaction bugs, fixed alongside inert in 15.5.
export const nativeInert = 'inert' in HTMLElement.prototype;

export async function prepareBrowser() {
  if (!nativeInert) await import('wicg-inert');
}

/** Explicitly isolate old dialog implementations, including SVG behind the modal. */
export function isolateDialog(dialog: HTMLDialogElement): () => void {
  if (nativeInert) return () => {};
  const saved: { element: HTMLElement; inert: boolean }[] = [];
  for (
    let branch: HTMLElement = dialog;
    branch.parentElement && branch !== document.body;
    branch = branch.parentElement
  ) {
    for (const sibling of branch.parentElement.children) {
      if (sibling === branch || !(sibling instanceof HTMLElement)) continue;
      if (['SCRIPT', 'STYLE', 'LINK'].includes(sibling.tagName)) continue;
      saved.push({ element: sibling, inert: sibling.inert });
      sibling.inert = true;
    }
  }
  return () => {
    for (const { element, inert } of saved) element.inert = inert;
  };
}
