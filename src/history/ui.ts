import { button, element, text } from '../screen';
import type { SessionSnapshot } from '../session';
import { createHistoryController } from './controller';
import { createHistoryView } from './view';

/**
 * Wire device-only history, hash navigation, explicit downloads and confirmed imports.
 * @param changed Refresh the practice/PWA locks after asynchronous history changes.
 * @returns Lifecycle observer and reload-safety predicate used by the main screen.
 */
export function setupHistory(changed: () => void) {
  let active = false;
  let updateLocked = false;
  let visible = false;
  const view = createHistoryView();
  const controller = createHistoryController({ changed: () => { draw(); changed(); } });
  const input = element<HTMLInputElement>('history-file');
  function draw(): void {
    const state = controller.state();
    const pending = state.busy || state.selecting || state.save === 'saving';
    const blocked = updateLocked || !controller.safe();
    text('history-storage', state.opening ? 'Opening local history…'
      : state.storageError ? `Local history unavailable: ${state.storageError} Practice still works.`
        : 'History stays on this device · IndexedDB local storage.');
    text('history-save', state.save === 'saving' ? 'Saving round on this device…'
      : state.save === 'saved' ? 'Saved on this device.'
        : state.save === 'error' ? `Round not saved. ${state.saveError} Keep this page open and Retry before playing again or reloading.`
          : '');
    element('history-save').className = state.save === 'error' ? 'error' : 'hint';
    element('history-retry').hidden = !state.storageError && !state.readError && state.save !== 'error';
    button('history-retry', pending || state.opening || updateLocked || active);
    text('history-read-error', state.readError ? `Could not refresh history. Displayed totals may be outdated. ${state.readError}` : '');
    element('history-read-error').hidden = !state.readError;
    text('history-transfer-error', state.error);
    element('history-transfer-error').hidden = !state.error;
    text('history-transfer-status', state.selecting ? 'Reading and validating local file…'
      : state.busy ? 'Working with local history…' : state.message);
    text('history-preview-text', state.preview
      ? `${state.preview.records.length} records selected · ${state.preview.added} to add · ${state.preview.duplicates} identical duplicates to skip. Existing records will not be overwritten.`
      : '');
    element('history-preview').hidden = !state.preview;
    input.disabled = blocked || active;
    button('history-export', blocked || active || state.opening || !!state.storageError);
    button('history-confirm', blocked || active || !state.preview);
    button('history-cancel', state.busy || updateLocked);
    button('history-refresh', blocked || active || state.opening);
    button('history-more', pending || updateLocked);
    if (visible) view.render(state.records);
  }
  function route(): void {
    if ((active || updateLocked || !visible && !controller.safe()) && window.location.hash === '#history') {
      window.history.replaceState(null, '', '#practice');
      text('history-navigation-note', active
        ? 'Finish or end the current attempt before opening History. Navigating away would interrupt it.'
        : 'Wait for the local save or retry the unsaved result before opening History.');
    }
    const next = !active && !updateLocked && (visible || controller.safe()) && window.location.hash === '#history';
    const opening = next && !visible;
    visible = next;
    element('practice-page').hidden = visible;
    element('history-page').hidden = !visible;
    element('nav-history').setAttribute('aria-current', visible ? 'page' : 'false');
    element('nav-practice').setAttribute('aria-current', !visible ? 'page' : 'false');
    button('nav-history', active || updateLocked || !controller.safe());
    button('nav-practice', updateLocked);
    if (opening) void controller.refresh();
    draw();
  }
  element('nav-history').addEventListener('click', () => {
    if (!active && !updateLocked && controller.safe()) { window.location.hash = '#history'; route(); }
  });
  element('nav-practice').addEventListener('click', () => {
    if (!updateLocked) { window.location.hash = '#practice'; route(); }
  });
  window.addEventListener('hashchange', route);
  element('history-retry').addEventListener('click', () => { void controller.retry(); });
  element('history-refresh').addEventListener('click', () => { void controller.refresh(); });
  element('history-more').addEventListener('click', view.more);
  input.addEventListener('change', () => {
    const selected = input.files?.[0];
    input.value = '';
    if (selected) void controller.select(selected);
  });
  element('history-cancel').addEventListener('click', () => controller.cancel());
  element('history-confirm').addEventListener('click', () => { void controller.confirm(); });
  element('history-export').addEventListener('click', () => {
    void (async () => {
      let url: string | undefined;
      let link: HTMLAnchorElement | undefined;
      try {
        const json = await controller.export();
        url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
        link = document.createElement('a');
        link.href = url;
        link.download = `chord-play-history-v2-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.append(link); link.click();
        text('history-transfer-status', 'Backup download requested. Check Downloads before clearing browser data or moving devices.');
      } catch {
        if (!controller.state().error) text('history-transfer-error', 'Backup download failed. Retry and check your browser’s download settings.');
        element('history-transfer-error').hidden = false;
      } finally {
        link?.remove();
        const downloadUrl = url;
        if (downloadUrl) window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
      }
    })();
  });
  return {
    /** Observe the session before rendering and enforce safe hash navigation. */
    observe(run: SessionSnapshot, locked: boolean, extraActive = false): void {
      active = extraActive || !['idle', 'finished'].includes(run.phase);
      updateLocked = locked;
      controller.observe(run);
      text('history-navigation-note', active
        ? 'History is unavailable during an unfinished attempt. End the round first; leaving interrupts capture.' : '');
      route();
    },
    /** Protect pending writes and retryable unsaved rounds from update reloads. */
    safe: controller.safe,
    beginRecord: controller.beginRecord,
    retainRecord: controller.retainRecord,
  };
}
