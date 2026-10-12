// Cloud Picker for Gmail: the button in Gmail's compose window.
//
// Gmail gives its compose toolbar no stable API, so the button goes next to
// the one control every compose window has and that has kept its attribute
// for years: the paperclip, [command="Files"]. That covers new messages,
// pop-outs, full-screen composes and inline Reply / Reply all / Forward. If
// Gmail ever drops that attribute, the button goes at the end of the compose
// toolbar row (tr.btC) instead.
//
// A click opens a small menu of the configured services. The background
// worker signs in, opens the service's own picker in a window, downloads what
// was chosen and hands the bytes back here, and this script attaches them
// through Gmail's own paperclip (see page-hook.js), so Gmail treats them like
// files chosen from the computer.
'use strict';

(function () {
  if (window.top !== window || window.__cloudPickerLoaded) return;
  window.__cloudPickerLoaded = true;

  const PROVIDERS = ['googledrive', 'dropbox', 'onedrive'];
  const BUTTON_ATTR = 'data-cloud-picker-button';
  // On the compose window itself, so a button Gmail re-renders keeps its id.
  const COMPOSE_ATTR = 'data-cloud-picker-compose';
  const ATTACH_WAIT_MS = 2500;
  const TOAST_HIDE_MS = 6000;

  const STRINGS = {
    en: {
      button: 'Attach from the cloud',
      googledrive: 'Google Drive',
      dropbox: 'Dropbox',
      onedrive: 'OneDrive',
      setUp: 'set up',
      settings: 'Settings…',
      opening: 'Opening {provider}…',
      notConfigured: '{provider} is not set up yet. Enter its details in the settings.',
      signInFailed: 'Signing in to {provider} did not finish.',
      openFailed: 'The picker could not be opened. Try again.',
      noExtension: 'The extension was updated or reloaded. Reload Gmail (F5), then try again.',
      downloading: 'Adding {count} file(s) from {provider}…',
      downloadingOne: 'Downloading {name} ({index} of {count})… {percent}',
      attaching: 'Attaching {count} file(s)…',
      attached: '{count} file(s) attached.',
      attachedDropped: '{count} file(s) added to the message.',
      attachFailed: 'Gmail did not accept the files. Try again, or use Gmail\'s own Attach button.',
      composeGone: 'The message window was closed before the files arrived.',
      transferFailed: 'The files could not be downloaded. Try again.',
      skipped: 'Not attached: {list}',
      TOO_LARGE: 'too large (over 100 MB)',
      FOLDER: 'folder',
      UNSUPPORTED: 'this kind of file cannot be attached',
      NOT_FOUND: 'not found, or no access',
      NETWORK: 'network error',
      PROVIDER_ERROR: 'download failed',
      SIGN_IN_REQUIRED: 'sign-in expired',
      close: 'Close'
    },
    hu: {
      button: 'Csatolás a felhőből',
      googledrive: 'Google Drive',
      dropbox: 'Dropbox',
      onedrive: 'OneDrive',
      setUp: 'beállítás',
      settings: 'Beállítások…',
      opening: '{provider} megnyitása…',
      notConfigured: 'A(z) {provider} még nincs beállítva. Adja meg az adatait a beállításokban.',
      signInFailed: 'A bejelentkezés a(z) {provider} szolgáltatásba nem fejeződött be.',
      openFailed: 'A választót nem sikerült megnyitni. Próbálja újra.',
      noExtension: 'A bővítmény frissült vagy újratöltődött. Töltse újra a Gmailt (F5), majd próbálja újra.',
      downloading: '{count} fájl hozzáadása innen: {provider}…',
      downloadingOne: '{name} letöltése ({index}/{count})… {percent}',
      attaching: '{count} fájl csatolása…',
      attached: '{count} fájl csatolva.',
      attachedDropped: '{count} fájl hozzáadva az üzenethez.',
      attachFailed: 'A Gmail nem fogadta el a fájlokat. Próbálja újra, vagy használja a Gmail saját Csatolás gombját.',
      composeGone: 'Az üzenetablak bezárult, mielőtt a fájlok megérkeztek.',
      transferFailed: 'A fájlokat nem sikerült letölteni. Próbálja újra.',
      skipped: 'Nincs csatolva: {list}',
      TOO_LARGE: 'túl nagy (100 MB felett)',
      FOLDER: 'mappa',
      UNSUPPORTED: 'ez a fájltípus nem csatolható',
      NOT_FOUND: 'nem található, vagy nincs hozzáférés',
      NETWORK: 'hálózati hiba',
      PROVIDER_ERROR: 'a letöltés nem sikerült',
      SIGN_IN_REQUIRED: 'a bejelentkezés lejárt',
      close: 'Bezárás'
    }
  };

  let lang = (navigator.language || '').toLowerCase().startsWith('hu') ? 'hu' : 'en';

  function t(key, values) {
    const text = (STRINGS[lang] || STRINGS.en)[key] || STRINGS.en[key] || key;
    return text.replace(/\{(\w+)\}/g, (_, name) => (values && name in values ? String(values[name]) : ''));
  }

  /** chrome.runtime.sendMessage that never throws: after an extension reload this script is orphaned. */
  function send(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (answer) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: 'NO_EXTENSION' });
            return;
          }
          resolve(answer || { ok: false, error: 'NO_ANSWER' });
        });
      } catch (_) {
        resolve({ ok: false, error: 'NO_EXTENSION' });
      }
    });
  }

  function randomId() {
    return Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  // -------------------------------------------------------------------------
  // The button
  // -------------------------------------------------------------------------

  // composeId → our newest button there; the compose is found again from it when files arrive.
  const buttons = new Map();

  const ICON_SVG = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">'
    + '<path fill="currentColor" d="M19.35 10.04A7.49 7.49 0 0 0 12 4C9.11 4 6.6 5.64 5.35 8.04A5.994 5.994 0 0 0 0 14c0 '
    + '3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13v4h-4v-4H7l5-5 5 5h-3z"/></svg>';

  function makeButton(composeId) {
    const button = document.createElement('div');
    button.setAttribute(BUTTON_ATTR, composeId);
    button.className = 'cloud-picker-compose-btn';
    button.setAttribute('role', 'button');
    button.setAttribute('tabindex', '0');
    button.setAttribute('aria-label', t('button'));
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('data-tooltip', t('button'));
    button.innerHTML = ICON_SVG;
    // Gmail's toolbar acts on mousedown; keep it from treating ours as its own.
    button.addEventListener('mousedown', (e) => { e.stopPropagation(); });
    button.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleMenu(button);
    });
    button.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        toggleMenu(button);
      }
    });
    buttons.set(composeId, button);
    return button;
  }

  /** The compose window around an element: the nearest ancestor holding the message body. */
  function composeRootOf(el) {
    for (let node = el; node && node !== document.body; node = node.parentElement) {
      if (node.querySelector('[contenteditable="true"]')) return node;
    }
    return null;
  }

  /** The paperclip of the compose window this button sits in. */
  function filesButtonFor(button) {
    if (!button.isConnected) return null;
    const near = button.parentElement && button.parentElement.querySelector('[command="Files"]');
    if (near) return near;
    const root = composeRootOf(button);
    return root ? root.querySelector('[command="Files"]') : null;
  }

  /** The id of the compose window `el` is in, given to it on first sight. */
  function composeIdFor(el) {
    const root = composeRootOf(el);
    if (!root) return randomId();
    let id = root.getAttribute(COMPOSE_ATTR);
    if (!id) {
      id = randomId();
      root.setAttribute(COMPOSE_ATTR, id);
    }
    return id;
  }

  function scan() {
    for (const [id, button] of buttons) {
      if (!button.isConnected) buttons.delete(id);
    }
    document.querySelectorAll('[command="Files"]').forEach((filesBtn) => {
      const parent = filesBtn.parentElement;
      if (!parent || parent.querySelector(`:scope > [${BUTTON_ATTR}]`)) return;
      filesBtn.insertAdjacentElement('afterend', makeButton(composeIdFor(filesBtn)));
    });
    // Fallback: a compose toolbar row whose paperclip Gmail no longer marks.
    document.querySelectorAll('tr.btC').forEach((row) => {
      if (row.querySelector(`[${BUTTON_ATTR}]`) || row.querySelector('[command="Files"]')) return;
      const cell = document.createElement('td');
      cell.className = 'cloud-picker-cell';
      cell.appendChild(makeButton(composeIdFor(row)));
      row.appendChild(cell);
    });
  }

  let scanQueued = false;
  function queueScan() {
    if (scanQueued) return;
    scanQueued = true;
    setTimeout(() => {
      scanQueued = false;
      scan();
    }, 150);
  }

  // -------------------------------------------------------------------------
  // The menu
  // -------------------------------------------------------------------------

  let menu = null;
  let menuButton = null;

  function closeMenu() {
    if (menu) menu.remove();
    if (menuButton) menuButton.setAttribute('aria-expanded', 'false');
    menu = null;
    menuButton = null;
  }

  async function toggleMenu(button) {
    if (menu && menuButton === button) {
      closeMenu();
      return;
    }
    closeMenu();
    const status = await send({ action: 'getProviders' });
    if (!status.ok) {
      toast(t(status.error === 'NO_EXTENSION' ? 'noExtension' : 'openFailed'), { error: true });
      return;
    }
    if (status.locale) lang = status.locale;

    menu = document.createElement('div');
    menu.className = 'cloud-picker-menu';
    menu.setAttribute('role', 'menu');
    menuButton = button;
    button.setAttribute('aria-expanded', 'true');

    const addItem = (label, note, onChoose) => {
      const item = document.createElement('div');
      item.className = 'cloud-picker-menu-item';
      item.setAttribute('role', 'menuitem');
      item.setAttribute('tabindex', '-1');
      item.textContent = label;
      if (note) {
        const small = document.createElement('span');
        small.className = 'cloud-picker-menu-note';
        small.textContent = note;
        item.appendChild(small);
      }
      const choose = (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeMenu();
        onChoose();
      };
      item.addEventListener('mousedown', (e) => { e.stopPropagation(); });
      item.addEventListener('click', choose);
      item.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') choose(e);
      });
      menu.appendChild(item);
      return item;
    };

    for (const provider of PROVIDERS) {
      const info = status.providers[provider] || {};
      addItem(t(provider), info.configured ? '' : t('setUp'), () => {
        if (info.configured) startPick(button, provider);
        else send({ action: 'openOptions' });
      });
    }
    const separator = document.createElement('div');
    separator.className = 'cloud-picker-menu-separator';
    menu.appendChild(separator);
    addItem(t('settings'), '', () => { send({ action: 'openOptions' }); });

    menu.addEventListener('keydown', (e) => {
      const items = Array.from(menu.querySelectorAll('[role="menuitem"]'));
      const at = items.indexOf(document.activeElement);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const next = e.key === 'ArrowDown' ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
        items[next].focus();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeMenu();
        button.focus();
      }
    });

    document.body.appendChild(menu);
    // Above the button (compose toolbars sit at the bottom of the screen), or below if there is no room.
    const rect = button.getBoundingClientRect();
    const height = menu.offsetHeight;
    const width = menu.offsetWidth;
    const top = rect.top - height - 6 >= 8 ? rect.top - height - 6 : rect.bottom + 6;
    const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8);
    menu.style.top = `${Math.round(top)}px`;
    menu.style.left = `${Math.round(left)}px`;
    const first = menu.querySelector('[role="menuitem"]');
    if (first) first.focus();
  }

  document.addEventListener('mousedown', (e) => {
    if (menu && !menu.contains(e.target) && e.target !== menuButton && !menuButton.contains(e.target)) closeMenu();
  }, true);
  window.addEventListener('resize', closeMenu);

  // -------------------------------------------------------------------------
  // Picking
  // -------------------------------------------------------------------------

  /** The signed-in Gmail address, from the tab title ("Inbox - name@example.com - Gmail"). */
  function gmailAccount() {
    const match = /[^\s@<>()"]+@[^\s@<>()"]+\.[^\s@<>()"]+/.exec(document.title);
    return match ? match[0] : '';
  }

  async function startPick(button, provider) {
    const composeId = button.getAttribute(BUTTON_ATTR);
    toast(t('opening', { provider: t(provider) }), { busy: true });
    const answer = await send({ action: 'openPicker', provider, composeId, accountHint: gmailAccount() });
    if (answer.ok) {
      hideToast();
      return;
    }
    const key = {
      NOT_CONFIGURED: 'notConfigured',
      SIGN_IN_REQUIRED: 'signInFailed',
      NO_EXTENSION: 'noExtension'
    }[answer.error] || 'openFailed';
    toast(t(key, { provider: t(provider) }), { error: true });
  }

  // -------------------------------------------------------------------------
  // Files arriving from the background worker
  // -------------------------------------------------------------------------

  function base64ToBytes(data) {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  async function collectFiles(transferId, files) {
    const result = [];
    for (let index = 0; index < files.length; index++) {
      const info = files[index];
      const parts = [];
      for (let chunk = 0; chunk < info.chunkCount; chunk++) {
        const answer = await send({ action: 'readChunk', transferId, file: index, chunk });
        if (!answer.ok) throw new Error(answer.error || 'TRANSFER_GONE');
        parts.push(base64ToBytes(answer.data));
      }
      result.push(new File(parts, info.name, { type: info.mimeType || 'application/octet-stream' }));
    }
    return result;
  }

  /** Through Gmail's own paperclip: page-hook.js fills the file input Gmail clicks. */
  function attachThroughGmail(filesBtn, files) {
    return new Promise((resolve) => {
      const token = randomId();
      let timer = 0;
      const onMessage = (event) => {
        if (event.source !== window || !event.data || event.data.token !== token) return;
        if (event.data.cloudPicker === 'armed') {
          pressFilesButton(filesBtn);
        } else if (event.data.cloudPicker === 'attached' || event.data.cloudPicker === 'attachFailed') {
          done(event.data.cloudPicker === 'attached');
        }
      };
      const done = (ok) => {
        clearTimeout(timer);
        window.removeEventListener('message', onMessage);
        if (!ok) window.postMessage({ cloudPicker: 'disarm', token }, location.origin);
        resolve(ok);
      };
      window.addEventListener('message', onMessage);
      window.postMessage({ cloudPicker: 'arm', token, files }, location.origin);
      timer = setTimeout(() => done(false), ATTACH_WAIT_MS);
    });
  }

  /** Gmail's buttons act on the mouse going down and up, not on "click" alone. */
  function pressFilesButton(filesBtn) {
    const rect = filesBtn.getBoundingClientRect();
    const init = {
      bubbles: true, cancelable: true, view: window, button: 0,
      clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2
    };
    ['mouseover', 'mousedown', 'mouseup', 'click'].forEach((type) => {
      filesBtn.dispatchEvent(new MouseEvent(type, init));
    });
  }

  /** Last resort: drop the files on the compose window, as if dragged from the desktop. */
  function dropOnCompose(button, files) {
    const root = composeRootOf(button);
    const target = root && root.querySelector('[contenteditable="true"]');
    if (!target) return false;
    const transfer = new DataTransfer();
    files.forEach((file) => transfer.items.add(file));
    ['dragenter', 'dragover', 'drop'].forEach((type) => {
      target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }));
    });
    return true;
  }

  function skippedText(failed) {
    if (!Array.isArray(failed) || failed.length === 0) return '';
    return t('skipped', {
      list: failed.slice(0, 5).map((f) => `${f.name} (${t(f.reason || 'PROVIDER_ERROR')})`).join(', ')
        + (failed.length > 5 ? ', …' : '')
    });
  }

  async function onTransferReady(message) {
    const button = buttons.get(message.composeId);
    const count = message.files.length;
    toast(t('attaching', { count }), { busy: true });
    let files;
    try {
      files = await collectFiles(message.transferId, message.files);
    } catch (_) {
      toast(t('transferFailed'), { error: true });
      return;
    } finally {
      send({ action: 'releaseTransfer', transferId: message.transferId });
    }
    const filesBtn = button && filesButtonFor(button);
    if (!button || !button.isConnected) {
      toast(t('composeGone'), { error: true });
      return;
    }
    const skipped = skippedText(message.failed);
    if (filesBtn && await attachThroughGmail(filesBtn, files)) {
      toast([t('attached', { count }), skipped].filter(Boolean).join(' '), { error: !!skipped });
    } else if (dropOnCompose(button, files)) {
      toast([t('attachedDropped', { count }), skipped].filter(Boolean).join(' '), { error: !!skipped });
    } else {
      toast(t('attachFailed'), { error: true });
    }
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || typeof message.composeId !== 'string') return;
    if (message.action === 'transferStart') {
      toast(t('downloading', { count: message.count, provider: t(message.provider) }), { busy: true });
    } else if (message.action === 'transferProgress') {
      const percent = message.total > 0 ? `${Math.min(100, Math.round((message.loaded / message.total) * 100))}%` : '';
      toast(t('downloadingOne', {
        name: message.name, index: message.index + 1, count: message.count, percent
      }), { busy: true });
    } else if (message.action === 'transferReady') {
      onTransferReady(message);
    } else if (message.action === 'transferFailed') {
      toast([t('transferFailed'), skippedText(message.failed)].filter(Boolean).join(' '), { error: true });
    }
  });

  // -------------------------------------------------------------------------
  // Status toast
  // -------------------------------------------------------------------------

  let toastEl = null;
  let toastTimer = 0;

  function toast(text, options) {
    const opts = options || {};
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'cloud-picker-toast';
      toastEl.setAttribute('role', 'status');
      toastEl.setAttribute('aria-live', 'polite');
      const textEl = document.createElement('span');
      textEl.className = 'cloud-picker-toast-text';
      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'cloud-picker-toast-close';
      closeBtn.textContent = '×';
      closeBtn.addEventListener('click', hideToast);
      toastEl.append(textEl, closeBtn);
      document.body.appendChild(toastEl);
    }
    toastEl.querySelector('.cloud-picker-toast-text').textContent = text;
    toastEl.querySelector('.cloud-picker-toast-close').setAttribute('aria-label', t('close'));
    toastEl.classList.toggle('cloud-picker-toast-error', !!opts.error);
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    // Errors stay until closed; progress stays until replaced.
    if (!opts.busy && !opts.error) toastTimer = setTimeout(hideToast, TOAST_HIDE_MS);
  }

  function hideToast() {
    clearTimeout(toastTimer);
    if (toastEl) toastEl.hidden = true;
  }

  // -------------------------------------------------------------------------

  new MutationObserver(queueScan).observe(document.documentElement, { childList: true, subtree: true });
  scan();
})();
