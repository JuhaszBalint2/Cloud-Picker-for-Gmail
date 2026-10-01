// Cloud Picker for Gmail: hosted page for the vendors' own file pickers.
//
// Manifest V3 extensions cannot load remote code, so the Google Picker (loaded
// from apis.google.com) and the Dropbox Chooser (dropins.js, registered domains
// only) cannot run inside the extension. The extension opens THIS page in a
// window of its own instead, and the page reports back over
// chrome.runtime.sendMessage, which the extension accepts from this URL only
// (externally_connectable in its manifest).
//
// What this page can and cannot do:
//   - It talks to exactly one extension (EXTENSION_ID), and only with the session
//     nonce the extension put in the URL fragment. Opened any other way, it does
//     nothing.
//   - It holds no secrets. The API key, project number and Dropbox app key are
//     public identifiers. For Google the extension also hands over a short-lived,
//     read-only Drive access token, used only to show the Picker.
//   - It sends back file ids and names, nothing else. The extension looks every
//     file up again with its own credentials, so nothing this page says is
//     trusted beyond which files were chosen.
'use strict';

(function () {
  // Derived from the "key" in the extension's manifest.json; a new key means a
  // new ID, and this constant must follow it.
  const EXTENSION_ID = 'hacjgahmjhepekmjdhmpdlfhjkkpdhgf';
  const GOOGLE_API_SRC = 'https://apis.google.com/js/api.js';
  const DROPBOX_DROPINS_SRC = 'https://www.dropbox.com/static/api/2/dropins.js';

  const STRINGS = {
    en: {
      title: 'Cloud Picker for Gmail',
      connecting: 'Connecting to the extension…',
      openFromExtension: 'Open this page with the extension\'s "Open Google Picker" or "Open Dropbox Chooser" button.',
      noExtension: 'The Cloud Picker extension is not installed or not enabled in this browser.',
      sessionInvalid: 'This picker window has expired. Close it and open the picker again from the extension.',
      signInRequired: 'Your Google Drive session has expired. Close this window, sign in again in the extension, then open the picker again.',
      loadingGoogle: 'Loading the Google Picker…',
      loadingDropbox: 'Loading the Dropbox Chooser…',
      loadFailed: 'The picker could not be loaded. Check your connection, then reload this window (F5).',
      googleReady: 'Choose your files in the Google Picker.',
      dropboxPrompt: 'Choose your files in Dropbox. They are added to your selection in the extension.',
      dropboxButton: 'Choose files from Dropbox',
      dropboxUnsupported: 'This browser cannot run the Dropbox Chooser.',
      sending: 'Adding your files…',
      sendFailed: 'Your files could not be handed to the extension. Close this window and try again.',
      done: 'Done. You can close this window.',
      cancel: 'Cancel',
      close: 'Close'
    },
    hu: {
      title: 'Cloud Picker for Gmail',
      connecting: 'Kapcsolódás a bővítményhez…',
      openFromExtension: 'Ezt az oldalt a bővítmény „Google-választó megnyitása” vagy „Dropbox-választó megnyitása” gombjával nyissa meg.',
      noExtension: 'A Cloud Picker bővítmény nincs telepítve vagy nincs engedélyezve ebben a böngészőben.',
      sessionInvalid: 'Ez a választóablak lejárt. Zárja be, és nyissa meg újra a választót a bővítményből.',
      signInRequired: 'A Google Drive-munkamenet lejárt. Zárja be ezt az ablakot, jelentkezzen be újra a bővítményben, majd nyissa meg újra a választót.',
      loadingGoogle: 'A Google-választó betöltése…',
      loadingDropbox: 'A Dropbox-választó betöltése…',
      loadFailed: 'A választót nem sikerült betölteni. Ellenőrizze a kapcsolatot, majd töltse újra az ablakot (F5).',
      googleReady: 'Válassza ki a fájlokat a Google-választóban.',
      dropboxPrompt: 'Válassza ki a fájlokat a Dropboxban. A fájlok a bővítményben a kijelöléshez adódnak.',
      dropboxButton: 'Fájlok kiválasztása a Dropboxból',
      dropboxUnsupported: 'Ez a böngésző nem tudja futtatni a Dropbox-választót.',
      sending: 'Fájlok hozzáadása…',
      sendFailed: 'A fájlokat nem sikerült átadni a bővítménynek. Zárja be az ablakot, és próbálja újra.',
      done: 'Kész. Bezárhatja ezt az ablakot.',
      cancel: 'Mégse',
      close: 'Bezárás'
    }
  };

  // Read the session, then drop it from the address bar and history at once.
  // sessionStorage keeps it for a reload (the extension allows a few per
  // session): it belongs to this one window and is gone when the window closes.
  const SESSION_STORAGE_KEY = 'cloudPickerSession';
  const params = new URLSearchParams(location.hash.slice(1));
  let session = params.get('session') || '';
  let provider = params.get('provider') || '';
  try {
    if (session) {
      sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ session, provider }));
    } else {
      const saved = JSON.parse(sessionStorage.getItem(SESSION_STORAGE_KEY) || 'null');
      if (saved && typeof saved.session === 'string' && typeof saved.provider === 'string') {
        session = saved.session;
        provider = saved.provider;
      }
    }
  } catch (_) {
    // Storage unavailable: a reload then needs the extension's button again.
  }
  if (location.hash) {
    try {
      history.replaceState(null, '', location.pathname);
    } catch (_) {
      // Best effort only.
    }
  }

  /** The session is over; a reload must not try it again. */
  function forgetSession() {
    try {
      sessionStorage.removeItem(SESSION_STORAGE_KEY);
    } catch (_) {
      // Nothing stored.
    }
  }

  const titleEl = document.getElementById('title');
  const statusEl = document.getElementById('status');
  const chooseBtn = document.getElementById('chooseBtn');
  const cancelBtn = document.getElementById('cancelBtn');

  // The extension's UI language once it answers; until then, the browser's.
  let lang = (navigator.language || '').toLowerCase().startsWith('hu') ? 'hu' : 'en';
  let finished = false;
  let statusKey = 'connecting';

  function t(key) {
    return (STRINGS[lang] || STRINGS.en)[key] || STRINGS.en[key] || '';
  }

  function setStatus(key) {
    statusKey = key;
    statusEl.textContent = t(key);
  }

  function applyLanguage() {
    document.documentElement.lang = lang;
    document.title = t('title');
    titleEl.textContent = t('title');
    statusEl.textContent = t(statusKey);
    cancelBtn.textContent = finished ? t('close') : t('cancel');
  }

  /** A final message: the only thing left to do is close the window. */
  function fail(key) {
    finished = true;
    setStatus(key);
    chooseBtn.hidden = true;
    cancelBtn.textContent = t('close');
    cancelBtn.hidden = false;
  }

  function send(message) {
    return new Promise((resolve) => {
      const runtime = window.chrome && window.chrome.runtime;
      if (!runtime || typeof runtime.sendMessage !== 'function') {
        resolve({ ok: false, error: 'NO_EXTENSION' });
        return;
      }
      try {
        runtime.sendMessage(EXTENSION_ID, Object.assign({ session }, message), (answer) => {
          if (runtime.lastError) {
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

  function loadScript(src, attributes) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      Object.keys(attributes || {}).forEach((name) => script.setAttribute(name, attributes[name]));
      script.src = src;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('Could not load ' + src));
      document.head.appendChild(script);
    });
  }

  /** Hand the chosen files to the extension, which closes this window. */
  async function deliver(files) {
    if (finished) return;
    finished = true;
    chooseBtn.hidden = true;
    cancelBtn.hidden = true;
    setStatus('sending');
    const items = (Array.isArray(files) ? files : [])
      .filter((f) => f && typeof f.id === 'string' && f.id)
      .map((f) => ({ id: f.id, name: typeof f.name === 'string' ? f.name : '' }));
    const answer = await send({ action: 'hostedPickerResult', items });
    if (answer && answer.ok) {
      forgetSession();
      setStatus('done');
      cancelBtn.textContent = t('close');
      cancelBtn.hidden = false;
    } else if (answer && answer.error === 'SESSION_INVALID') {
      forgetSession();
      fail('sessionInvalid');
    } else {
      // Kept: if the extension never got the files, a reload can pick again.
      fail('sendFailed');
    }
  }

  async function cancel() {
    if (!finished) {
      finished = true;
      await send({ action: 'hostedPickerCancel' });
    }
    forgetSession();
    // The extension closes the window itself; this covers the case where it
    // could not be reached. A browser may refuse, which is harmless.
    window.close();
  }

  async function runGoogle(config) {
    setStatus('loadingGoogle');
    await loadScript(GOOGLE_API_SRC);
    await new Promise((resolve, reject) => {
      window.gapi.load('picker', {
        callback: resolve,
        onerror: () => reject(new Error('Google Picker failed to load')),
        timeout: 20000,
        ontimeout: () => reject(new Error('Google Picker timed out'))
      });
    });

    const picker = window.google.picker;
    const myDrive = new picker.DocsView(picker.ViewId.DOCS)
      .setIncludeFolders(true)
      .setSelectFolderEnabled(false);
    const sharedDrives = new picker.DocsView(picker.ViewId.DOCS)
      .setEnableDrives(true)
      .setIncludeFolders(true)
      .setSelectFolderEnabled(false);

    const builder = new picker.PickerBuilder()
      .addView(myDrive)
      .addView(sharedDrives)
      .enableFeature(picker.Feature.MULTISELECT_ENABLED)
      .enableFeature(picker.Feature.SUPPORT_DRIVES)
      .setOAuthToken(config.googleToken)
      .setDeveloperKey(config.googleApiKey)
      .setLocale(lang)
      .setCallback((data) => {
        const action = data[picker.Response.ACTION];
        if (action === picker.Action.PICKED) {
          const docs = data[picker.Response.DOCUMENTS] || [];
          deliver(docs.map((doc) => ({ id: doc[picker.Document.ID], name: doc[picker.Document.NAME] })));
        } else if (action === picker.Action.CANCEL) {
          cancel();
        }
      });
    if (config.googleAppId) builder.setAppId(config.googleAppId);
    builder.build().setVisible(true);
    setStatus('googleReady');
  }

  async function runDropbox(config) {
    setStatus('loadingDropbox');
    // dropins.js reads the app key from its own script tag, so the attributes
    // have to be on the element before it loads.
    await loadScript(DROPBOX_DROPINS_SRC, { id: 'dropboxjs', 'data-app-key': config.dropboxAppKey });
    if (!window.Dropbox || !window.Dropbox.isBrowserSupported()) {
      fail('dropboxUnsupported');
      return;
    }
    setStatus('dropboxPrompt');
    chooseBtn.textContent = t('dropboxButton');
    chooseBtn.hidden = false;
    // Dropbox.choose opens a popup, which browsers allow only from a click.
    chooseBtn.addEventListener('click', () => {
      window.Dropbox.choose({
        // 'direct' rather than 'preview': a preview link can create a share link
        // as a side effect, and only the ids are used anyway.
        linkType: 'direct',
        multiselect: true,
        folderselect: false,
        success: (files) => deliver(files),
        cancel: () => setStatus('dropboxPrompt')
      });
    });
  }

  async function start() {
    applyLanguage();
    cancelBtn.addEventListener('click', () => { cancel(); });

    if (!session || (provider !== 'googledrive' && provider !== 'dropbox')) {
      fail('openFromExtension');
      return;
    }
    cancelBtn.hidden = false;
    setStatus('connecting');

    const config = await send({ action: 'hostedPickerInit' });
    if (config && config.locale) {
      lang = config.locale === 'hu' ? 'hu' : 'en';
      applyLanguage();
    }
    if (!config || !config.ok) {
      const error = config && config.error;
      if (error === 'NO_EXTENSION') {
        fail('noExtension');   // kept: a reload works once the extension is back
      } else {
        forgetSession();
        fail(error === 'SIGN_IN_REQUIRED' ? 'signInRequired' : 'sessionInvalid');
      }
      return;
    }

    try {
      if (config.provider === 'googledrive') {
        await runGoogle(config);
      } else if (config.provider === 'dropbox') {
        await runDropbox(config);
      } else {
        fail('openFromExtension');
      }
    } catch (_) {
      fail('loadFailed');
    }
  }

  start();
})();
