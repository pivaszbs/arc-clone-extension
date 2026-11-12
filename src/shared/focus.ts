// Works in extension pages and in the content script's ShadowRoot.
export function containFocus(node: HTMLElement, enabled = true) {
  if (!enabled) return {};
  const root = node.getRootNode() as Document | ShadowRoot;
  const previous = root.activeElement;
  const focusable = () => Array.from(node.querySelectorAll<HTMLElement>(
    'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]'
  )).filter((element) => element.getClientRects().length > 0);
  queueMicrotask(() => {
    if (!node.isConnected) return;
    const first = node.querySelector<HTMLElement>('[data-autofocus]') || focusable()[0] || node;
    first.focus();
  });
  const onKeydown = (event: KeyboardEvent) => {
    if (event.key !== 'Tab') return;
    const items = focusable();
    const first = items[0];
    const last = items.at(-1);
    if (!first) { event.preventDefault(); node.focus(); return; }
    if (event.shiftKey && (root.activeElement === first || root.activeElement === node)) {
      event.preventDefault(); last?.focus();
    } else if (!event.shiftKey && root.activeElement === last) {
      event.preventDefault(); first.focus();
    }
  };
  node.addEventListener('keydown', onKeydown);
  return { destroy() {
    node.removeEventListener('keydown', onKeydown);
    if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
  } };
}

export function isActivationKey(event: KeyboardEvent): boolean {
  if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return false;
  event.preventDefault();
  return true;
}
