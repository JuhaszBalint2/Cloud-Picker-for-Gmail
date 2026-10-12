// Cloud Picker for Gmail: hosted page for the vendors' own file pickers.
//
// Manifest V3 extensions cannot load remote code, so the Google Picker (loaded
// from apis.google.com) and the Dropbox Chooser (dropins.js, registered domains
// only) cannot run inside the extension, and Microsoft's OneDrive File Picker
// needs a website that signs in to Microsoft at a registered address. The
// extension opens THIS page in a window of its own instead, and the page
// reports back over chrome.runtime.sendMessage, which the extension accepts
// from this URL only (externally_connectable in its manifest).
//
// What this page can and cannot do:
//   - It talks to one extension (from EXTENSION_IDS, named by ext= in the URL
//     fragment), and only with the session nonce the extension put there.
//     Opened any other way, it does nothing.
//   - It holds no secrets. The API key, project number, Dropbox app key and
//     Microsoft client id are public identifiers. For Google the extension also
//     hands over a short-lived Drive access token (drive.file: it reaches only
//     the files picked here), used only to show the Picker. For OneDrive it hands over no token at all: the page signs in
//     to Microsoft by itself (see the OneDrive section), and those tokens stay
//     in this window's memory and go to Microsoft's picker only.
//   - It sends back file ids and names (for OneDrive, with the drive id), nothing
//     else. The extension looks every file up again with its own credentials,
//     so nothing this page says is trusted beyond which files were chosen.
'use strict';

(function () {
  // The extensions this page answers to, each derived from the "key" in its
  // manifest.json; a new key means a new ID, and this list must follow it. The
  // extension names itself in the fragment (ext=); without that, the first.
  // The second is the extension in this repository's extension/ folder.
  const EXTENSION_IDS = ['hacjgahmjhepekmjdhmpdlfhjkkpdhgf', 'lpopajldbemheobeghoaphkhkbpcplne'];
  const GOOGLE_API_SRC = 'https://apis.google.com/js/api.js';
  const DROPBOX_DROPINS_SRC = 'https://www.dropbox.com/static/api/2/dropins.js';
  const PROVIDERS = ['googledrive', 'dropbox', 'onedrive'];

  const STRINGS = {
    en: {
      title: 'Cloud Picker for Gmail',
      connecting: 'Connecting to the extension…',
      openFromExtension: 'The Cloud Picker extension opens this page for you when you choose files from Google Drive, Dropbox or OneDrive.',
      noExtension: 'The Cloud Picker extension is not installed or not enabled in this browser.',
      sessionInvalid: 'This picker window has expired. Close it and open the picker again from the extension.',
      signInRequired: 'Your Google Drive session has expired. Close this window, sign in again in the extension, then open the picker again.',
      signInRequiredOneDrive: 'Your OneDrive session in the extension has expired. Close this window, sign in to OneDrive again in the extension, then open the picker again.',
      loadingGoogle: 'Loading the Google Picker…',
      loadingDropbox: 'Loading the Dropbox Chooser…',
      loadFailed: 'The picker could not be loaded. Check your connection, then reload this window (F5).',
      googleReady: 'Choose your files in the Google Picker.',
      dropboxPrompt: 'Choose your files in Dropbox. They are added to your selection in the extension.',
      dropboxButton: 'Choose files from Dropbox',
      dropboxUnsupported: 'This browser cannot run the Dropbox Chooser.',
      msSigningIn: 'Signing in to Microsoft…',
      msSignInPrompt: 'Sign in with your Microsoft account to choose files in OneDrive.',
      msSignInButton: 'Sign in to Microsoft',
      msSignInFailed: 'The Microsoft sign-in did not finish. Try again, or close this window.',
      msConsentDenied: 'The sign-in was cancelled, or access to your files was not allowed. To use the OneDrive picker, sign in again and allow access.',
      msRedirectMissing: 'Microsoft does not accept this page\'s address (AADSTS50011). In Azure, add it to the app as a single-page application redirect URI.',
      msNotSpa: 'This page\'s address is registered in Azure as a web redirect URI. Move it to the "Single-page application" platform, then try again.',
      msAccountsNotAllowed: 'The Microsoft app this page signs in with does not accept this kind of account. In Azure, set its supported account types to any organizational directory and personal Microsoft accounts.',
      msLoadingPicker: 'Loading the OneDrive picker…',
      msSlow: 'The OneDrive picker is taking a long time to load in this window. You can open it in a separate window instead.',
      msOpenWindow: 'Open in a separate window',
      msWindowOpen: 'Choose your files in the OneDrive window.',
      msShowWindow: 'Show the OneDrive window',
      msWindowClosed: 'The OneDrive window was closed before any files were chosen.',
      msReopenWindow: 'Open the OneDrive picker again',
      msPopupBlocked: 'The browser blocked the OneDrive window. Allow pop-ups for this page, then try again.',
      msFrameTitle: 'OneDrive file picker',
      retry: 'Try again',
      sending: 'Adding your files…',
      sendFailed: 'Your files could not be handed to the extension. Close this window and try again.',
      done: 'Done. You can close this window.',
      cancel: 'Cancel',
      close: 'Close'
    },
    hu: {
      title: 'Cloud Picker for Gmail',
      connecting: 'Kapcsolódás a bővítményhez…',
      openFromExtension: 'Ezt az oldalt a Cloud Picker bővítmény nyitja meg, amikor a Google Drive-ból, a Dropboxból vagy a OneDrive-ból választ fájlokat.',
      noExtension: 'A Cloud Picker bővítmény nincs telepítve vagy nincs engedélyezve ebben a böngészőben.',
      sessionInvalid: 'Ez a választóablak lejárt. Zárja be, és nyissa meg újra a választót a bővítményből.',
      signInRequired: 'A Google Drive-munkamenet lejárt. Zárja be ezt az ablakot, jelentkezzen be újra a bővítményben, majd nyissa meg újra a választót.',
      signInRequiredOneDrive: 'A bővítmény OneDrive-munkamenete lejárt. Zárja be ezt az ablakot, jelentkezzen be újra a OneDrive-ba a bővítményben, majd nyissa meg újra a választót.',
      loadingGoogle: 'A Google-választó betöltése…',
      loadingDropbox: 'A Dropbox-választó betöltése…',
      loadFailed: 'A választót nem sikerült betölteni. Ellenőrizze a kapcsolatot, majd töltse újra az ablakot (F5).',
      googleReady: 'Válassza ki a fájlokat a Google-választóban.',
      dropboxPrompt: 'Válassza ki a fájlokat a Dropboxban. A fájlok a bővítményben a kijelöléshez adódnak.',
      dropboxButton: 'Fájlok kiválasztása a Dropboxból',
      dropboxUnsupported: 'Ez a böngésző nem tudja futtatni a Dropbox-választót.',
      msSigningIn: 'Bejelentkezés a Microsoftba…',
      msSignInPrompt: 'A OneDrive-fájlok kiválasztásához jelentkezzen be a Microsoft-fiókjával.',
      msSignInButton: 'Bejelentkezés a Microsoftba',
      msSignInFailed: 'A Microsoft-bejelentkezés nem fejeződött be. Próbálja újra, vagy zárja be ezt az ablakot.',
      msConsentDenied: 'A bejelentkezés megszakadt, vagy a fájlokhoz való hozzáférés nem lett engedélyezve. A OneDrive-választó használatához jelentkezzen be újra, és engedélyezze a hozzáférést.',
      msRedirectMissing: 'A Microsoft nem fogadja el ennek az oldalnak a címét (AADSTS50011). Az Azure-ban adja hozzá az alkalmazáshoz egyoldalas alkalmazás (SPA) átirányítási URI-ként.',
      msNotSpa: 'Ennek az oldalnak a címe az Azure-ban webes átirányítási URI-ként van regisztrálva. Helyezze át az „Egyoldalas alkalmazás” platformra, majd próbálja újra.',
      msAccountsNotAllowed: 'Az alkalmazás, amellyel ez az oldal a Microsoftba bejelentkezik, nem fogadja el ezt a fióktípust. Az Azure-ban állítsa a támogatott fióktípusokat bármely szervezeti címtárra és személyes Microsoft-fiókokra.',
      msLoadingPicker: 'A OneDrive-választó betöltése…',
      msSlow: 'A OneDrive-választó lassan töltődik be ebben az ablakban. Megnyithatja külön ablakban is.',
      msOpenWindow: 'Megnyitás külön ablakban',
      msWindowOpen: 'Válassza ki a fájlokat a OneDrive-ablakban.',
      msShowWindow: 'OneDrive-ablak megjelenítése',
      msWindowClosed: 'A OneDrive-ablak bezárult, mielőtt fájlokat választott volna.',
      msReopenWindow: 'OneDrive-választó újbóli megnyitása',
      msPopupBlocked: 'A böngésző letiltotta a OneDrive-ablakot. Engedélyezze az előugró ablakokat ezen az oldalon, majd próbálja újra.',
      msFrameTitle: 'OneDrive-fájlválasztó',
      retry: 'Próbálja újra',
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
  // OneDrive only: the extension's answer and the sign-in in progress, kept
  // across the trip to Microsoft's sign-in page and back.
  const MS_INIT_STORAGE_KEY = 'cloudPickerMsInit';
  const MS_AUTH_STORAGE_KEY = 'cloudPickerMsAuth';
  const params = new URLSearchParams(location.hash.slice(1));
  let session = params.get('session') || '';
  let provider = params.get('provider') || '';
  let extensionId = params.get('ext') || '';
  // Microsoft's answer to a sign-in started here arrives in the fragment too.
  const msAuthResponse = params.has('code') || params.has('error')
    ? {
        code: params.get('code') || '',
        state: params.get('state') || '',
        error: params.get('error') || '',
        description: params.get('error_description') || ''
      }
    : null;
  try {
    if (session) {
      sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ session, provider, extensionId }));
    } else {
      const saved = JSON.parse(sessionStorage.getItem(SESSION_STORAGE_KEY) || 'null');
      if (saved && typeof saved.session === 'string' && typeof saved.provider === 'string') {
        session = saved.session;
        provider = saved.provider;
        extensionId = typeof saved.extensionId === 'string' ? saved.extensionId : '';
      }
    }
  } catch (_) {
    // Storage unavailable: a reload then needs the extension's button again.
  }
  if (!EXTENSION_IDS.includes(extensionId)) extensionId = EXTENSION_IDS[0];
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
      sessionStorage.removeItem(MS_INIT_STORAGE_KEY);
      sessionStorage.removeItem(MS_AUTH_STORAGE_KEY);
    } catch (_) {
      // Nothing stored.
    }
  }

  const titleEl = document.getElementById('title');
  const statusEl = document.getElementById('status');
  const detailEl = document.getElementById('detail');
  const chooseBtn = document.getElementById('chooseBtn');
  const cancelBtn = document.getElementById('cancelBtn');
  const frameHost = document.getElementById('msFrameHost');

  // The extension's UI language once it answers; until then, the browser's.
  let lang = (navigator.language || '').toLowerCase().startsWith('hu') ? 'hu' : 'en';
  let finished = false;
  let statusKey = 'connecting';
  let chooseKey = '';
  let chooseAction = null;

  function t(key) {
    return (STRINGS[lang] || STRINGS.en)[key] || STRINGS.en[key] || '';
  }

  function setStatus(key) {
    statusKey = key;
    statusEl.textContent = t(key);
  }

  /** The primary button: its label and what a click does, or no button at all. */
  function setChoose(key, action) {
    chooseKey = key || '';
    chooseAction = key ? action : null;
    chooseBtn.textContent = key ? t(key) : '';
    chooseBtn.hidden = !key;
  }

  /** Small print under the status, such as Microsoft's error code. Always plain text. */
  function setDetail(text) {
    detailEl.textContent = text || '';
    detailEl.hidden = !text;
  }

  function applyLanguage() {
    document.documentElement.lang = lang;
    document.title = t('title');
    titleEl.textContent = t('title');
    statusEl.textContent = t(statusKey);
    if (chooseKey) chooseBtn.textContent = t(chooseKey);
    cancelBtn.textContent = finished ? t('close') : t('cancel');
    const frame = frameHost.querySelector('iframe');
    if (frame) frame.title = t('msFrameTitle');
  }

  /** OneDrive: the picker's iframe over the whole window, or the card again. */
  function showFrame(shown) {
    document.body.classList.toggle('frame-ready', shown);
    frameHost.inert = !shown;
  }

  /** A final message: the only thing left to do is close the window. */
  function fail(key) {
    finished = true;
    showFrame(false);
    setStatus(key);
    setChoose('');
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
        runtime.sendMessage(extensionId, Object.assign({ session }, message), (answer) => {
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
    showFrame(false);
    setChoose('');
    cancelBtn.hidden = true;
    setStatus('sending');
    const items = (Array.isArray(files) ? files : [])
      .filter((f) => f && typeof f.id === 'string' && f.id)
      .map((f) => {
        const item = { id: f.id, name: typeof f.name === 'string' ? f.name : '' };
        // A OneDrive id is unique only within its drive.
        if (typeof f.driveId === 'string' && f.driveId) item.driveId = f.driveId;
        return item;
      });
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
    closeMsPopup();
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
    // Dropbox.choose opens a popup, which browsers allow only from a click.
    setChoose('dropboxButton', () => {
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

  // ---------------------------------------------------------------------------
  // OneDrive File Picker v8
  // https://learn.microsoft.com/onedrive/developer/controls/file-pickers/
  // ---------------------------------------------------------------------------
  // Microsoft's picker is a Microsoft page that this page loads by POSTing an
  // access token to it, then talks to over a MessageChannel, answering its
  // commands: "authenticate" with a token, "pick" with the chosen files,
  // "close" when the user cancels.
  //
  // Signing in, the way Microsoft documents it for websites: authorization code
  // with PKCE, as a full-page redirect in this window (no extra popup for a
  // browser to block), back to this page's own address, which the Azure app
  // must list as a single-page application redirect URI. Microsoft answers in
  // the URL FRAGMENT, which a browser never sends to a server, so GitHub never
  // sees the code, and the fragment leaves the address bar at once (above). The
  // PKCE verifier and state wait in sessionStorage across the redirect; the
  // tokens live in memory only and go to Microsoft's picker only.
  //   Personal account: /consumers and OneDrive.ReadOnly, the one token for every
  //     command, as in Microsoft's consumer sample.
  //   Work or school: /organizations and <host>/.default for each SharePoint
  //     host the picker asks for, minted from the refresh token.
  // The extension says which kind of account it is connected to and where its
  // picker lives (from Graph /me/drive), plus that account's sign-in name as
  // login_hint, so this page signs in to the account whose token later
  // resolves the picks.
  //
  // The picker runs in an iframe that fills this window. If it never says
  // "initialize" there, it is offered in a window of its own.

  const MS_LOGIN_ORIGIN = 'https://login.microsoftonline.com';
  const MS_PERSONAL_PICKER_ORIGIN = 'https://onedrive.live.com';
  const MS_CLIENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const SHAREPOINT_HOST_RE = /^[a-z0-9-]+\.sharepoint\.com$/i;
  // Where Microsoft's picker may post from. A second line of defense: the
  // message must also come from the very window this page loaded the picker
  // into, on this page's random channel id.
  const MS_PICKER_HOST_RE = /(^|\.)(sharepoint\.com|live\.com|onedrive\.com|microsoftpersonalcontent\.com|microsoft\.com|cloud\.microsoft|office\.com|office\.net)$/i;
  // As long as the extension's own session for this window lasts.
  const MS_SIGN_IN_MAX_AGE_MS = 15 * 60 * 1000;
  const MS_TOKEN_MARGIN_MS = 2 * 60 * 1000;
  const MS_FRAME_TIMEOUT_MS = 12000;
  // The extension resolves no more than this from one pick.
  const MS_MAX_ITEMS = 500;
  // Microsoft's recommended maximum size for the picker.
  const MS_POPUP_FEATURES = 'popup=yes,width=1080,height=680';
  // Error codes of this page's own, which mean nothing to the user.
  const MS_INTERNAL_ERRORS = ['state_mismatch', 'no_code', 'sign_in_required', 'network'];

  let msConfig = null;
  let msRefreshToken = '';
  const msAccessTokens = new Map();   // scope → { token, expiresAt }
  let msTokenQueue = Promise.resolve();
  let msChannelId = '';
  let msTarget = null;                // the window the picker was loaded into
  let msPort = null;
  let msPopup = null;
  let msFrameTimer = 0;
  let msPopupTimer = 0;

  /** The OneDrive part of the extension's answer, checked; null if unusable. */
  function readMsConfig(answer) {
    if (!answer || answer.provider !== 'onedrive') return null;
    const clientId = typeof answer.msClientId === 'string' ? answer.msClientId : '';
    const kind = answer.msKind === 'personal' || answer.msKind === 'business' ? answer.msKind : '';
    let pickerUrl = null;
    try {
      pickerUrl = new URL(answer.msPickerUrl);
    } catch (_) {
      pickerUrl = null;
    }
    if (!MS_CLIENT_ID_RE.test(clientId) || !kind || !pickerUrl || pickerUrl.protocol !== 'https:') return null;
    const placeOk = kind === 'personal'
      ? pickerUrl.origin === MS_PERSONAL_PICKER_ORIGIN
      : SHAREPOINT_HOST_RE.test(pickerUrl.hostname);
    if (!placeOk) return null;
    return {
      clientId,
      kind,
      pickerUrl: pickerUrl.origin + pickerUrl.pathname,
      loginHint: typeof answer.msLoginHint === 'string' ? answer.msLoginHint.slice(0, 320) : ''
    };
  }

  /** The answer kept for this session, if any. */
  function loadSavedInit() {
    try {
      const saved = JSON.parse(sessionStorage.getItem(MS_INIT_STORAGE_KEY) || 'null');
      if (saved && saved.session === session && saved.answer && typeof saved.answer === 'object') {
        return saved.answer;
      }
    } catch (_) {
      // Unreadable: the extension is asked again.
    }
    return null;
  }

  /** Public facts only: no token was in the answer to begin with. */
  function saveInit(answer) {
    try {
      sessionStorage.setItem(MS_INIT_STORAGE_KEY, JSON.stringify({
        session,
        answer: {
          ok: true,
          provider: 'onedrive',
          locale: answer.locale,
          msClientId: answer.msClientId,
          msKind: answer.msKind,
          msPickerUrl: answer.msPickerUrl,
          msLoginHint: answer.msLoginHint
        }
      }));
    } catch (_) {
      // Then the return from Microsoft asks the extension again.
    }
  }

  function msEndpoint(name) {
    const tenant = msConfig.kind === 'personal' ? 'consumers' : 'organizations';
    return `${MS_LOGIN_ORIGIN}/${tenant}/oauth2/v2.0/${name}`;
  }

  /** The scope of the token the picker's own address needs. */
  function msPickerScope() {
    return msConfig.kind === 'personal'
      ? 'OneDrive.ReadOnly'
      : `${new URL(msConfig.pickerUrl).origin}/.default`;
  }

  /** This page's address: the redirect URI the Azure app must list. */
  function msRedirectUri() {
    return location.origin + location.pathname.replace(/index\.html$/, '');
  }

  function base64Url(bytes) {
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function randomToken(byteCount) {
    return base64Url(crypto.getRandomValues(new Uint8Array(byteCount)));
  }

  /** The sign-in this window started and has not finished, if any. */
  function readPendingSignIn() {
    try {
      const pending = JSON.parse(sessionStorage.getItem(MS_AUTH_STORAGE_KEY) || 'null');
      if (pending && pending.session === session
          && typeof pending.state === 'string' && pending.state
          && typeof pending.verifier === 'string' && pending.verifier
          && typeof pending.scope === 'string' && pending.scope
          && Date.now() - pending.startedAt < MS_SIGN_IN_MAX_AGE_MS) {
        return pending;
      }
    } catch (_) {
      // Unreadable: as if there were none.
    }
    return null;
  }

  function clearPendingSignIn() {
    try {
      sessionStorage.removeItem(MS_AUTH_STORAGE_KEY);
    } catch (_) {
      // Nothing stored.
    }
  }

  /** Off to Microsoft; this window comes back to this page with the answer. */
  async function beginMsSignIn() {
    setDetail('');
    setChoose('');
    setStatus('msSigningIn');
    const verifier = randomToken(32);
    const state = randomToken(16);
    const challenge = base64Url(new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
    ));
    const scope = msPickerScope();
    sessionStorage.setItem(MS_AUTH_STORAGE_KEY, JSON.stringify({
      session, state, verifier, scope, startedAt: Date.now()
    }));
    const query = new URLSearchParams({
      client_id: msConfig.clientId,
      response_type: 'code',
      redirect_uri: msRedirectUri(),
      response_mode: 'fragment',
      scope: `${scope} openid offline_access`,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256'
    });
    if (msConfig.loginHint) query.set('login_hint', msConfig.loginHint);
    // replace(): Back from the picker must not land on a half-finished sign-in.
    location.replace(`${msEndpoint('authorize')}?${query}`);
  }

  /** Back from Microsoft: make sure it answers this window's sign-in, then redeem the code. */
  async function finishMsSignIn(response) {
    const pending = readPendingSignIn();
    clearPendingSignIn();   // single use, whatever happens next
    if (!pending || pending.state !== response.state) throw msError('state_mismatch');
    if (response.error) throw msError(response.error, response.description);
    if (!response.code) throw msError('no_code');
    const body = await msTokenRequest({
      grant_type: 'authorization_code',
      code: response.code,
      redirect_uri: msRedirectUri(),
      code_verifier: pending.verifier,
      scope: `${pending.scope} openid offline_access`
    });
    keepMsTokens(pending.scope, body);
  }

  async function msTokenRequest(fields) {
    let res;
    try {
      res = await fetch(msEndpoint('token'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(Object.assign({ client_id: msConfig.clientId }, fields)).toString(),
        credentials: 'omit',
        cache: 'no-store'
      });
    } catch (_) {
      throw msError('network');
    }
    let body = null;
    try {
      body = await res.json();
    } catch (_) {
      body = null;
    }
    if (!res.ok || !body || typeof body.access_token !== 'string' || !body.access_token) {
      throw msError((body && body.error) || `http_${res.status}`, body && body.error_description);
    }
    return body;
  }

  function keepMsTokens(scope, body) {
    const seconds = Number(body.expires_in);
    msAccessTokens.set(scope, {
      token: body.access_token,
      expiresAt: Date.now() + (seconds > 0 ? seconds : 3600) * 1000
    });
    if (typeof body.refresh_token === 'string' && body.refresh_token) msRefreshToken = body.refresh_token;
  }

  /** A valid access token for `scope`, renewing one at a time. */
  function msAccessToken(scope) {
    const run = async () => {
      const cached = msAccessTokens.get(scope);
      if (cached && cached.expiresAt - MS_TOKEN_MARGIN_MS > Date.now()) return cached.token;
      if (!msRefreshToken) throw msError('sign_in_required');
      const body = await msTokenRequest({
        grant_type: 'refresh_token',
        refresh_token: msRefreshToken,
        scope: `${scope} openid offline_access`
      });
      keepMsTokens(scope, body);
      return body.access_token;
    };
    const result = msTokenQueue.then(run, run);
    msTokenQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  /** The scope an "authenticate" command asks for, or null when this page does not hand that out. */
  function msScopeFor(command) {
    if (msConfig.kind === 'personal') return msPickerScope();
    let url = null;
    try {
      url = new URL(command && command.resource);
    } catch (_) {
      url = null;
    }
    if ((command && command.type === 'Graph') || (url && url.origin === 'https://graph.microsoft.com')) {
      return 'https://graph.microsoft.com/.default';
    }
    if (url && url.protocol === 'https:' && SHAREPOINT_HOST_RE.test(url.hostname)) return `${url.origin}/.default`;
    return null;
  }

  function msError(code, description) {
    const text = typeof description === 'string' ? description : '';
    const error = new Error(String(code || 'unknown'));
    error.code = String(code || '');
    const aadsts = /AADSTS\d+/.exec(text);
    error.aadsts = aadsts ? aadsts[0] : '';
    // The first line only: the rest is trace and correlation ids.
    error.detail = text.split(/\r?\n/)[0].trim().slice(0, 300);
    return error;
  }

  function msErrorKey(error) {
    const code = (error && error.code) || '';
    const aadsts = (error && error.aadsts) || '';
    if (aadsts === 'AADSTS50011') return 'msRedirectMissing';
    if (aadsts === 'AADSTS9002326') return 'msNotSpa';
    if (code === 'unauthorized_client' || ['AADSTS50020', 'AADSTS50194', 'AADSTS700016'].includes(aadsts)) {
      return 'msAccountsNotAllowed';
    }
    if (code === 'access_denied' || code === 'consent_required' || aadsts === 'AADSTS65004') return 'msConsentDenied';
    if (code === 'network') return 'loadFailed';
    return 'msSignInFailed';
  }

  /** A sign-in problem: say what Microsoft said, and offer to sign in again. */
  function showMsError(error) {
    if (finished) return;
    destroyMsFrame();
    closeMsPopup();
    setStatus(msErrorKey(error));
    const code = (error && error.code) || '';
    setDetail((error && error.detail) || (MS_INTERNAL_ERRORS.includes(code) ? '' : code));
    setChoose('retry', () => {
      beginMsSignIn().catch(() => fail('loadFailed'));
    });
  }

  function msPickerOptions() {
    return {
      sdk: '8.0',
      entry: { oneDrive: { files: {} } },
      // Present, even empty: this page hands out the tokens. Required in an iframe.
      authentication: {},
      messaging: { origin: location.origin, channelId: msChannelId },
      typesAndSources: { mode: 'files' },
      selection: { mode: 'multiple', enablePersistence: true, maximumCount: MS_MAX_ITEMS },
      commands: {
        // The picks must come from the account the extension is connected to.
        switchAccount: { mode: 'none' },
        manageAccounts: { mode: 'none' }
      }
    };
  }

  function msPickerAddress() {
    const url = new URL(msConfig.pickerUrl);
    url.searchParams.set('filePicker', JSON.stringify(msPickerOptions()));
    url.searchParams.set('locale', lang === 'hu' ? 'hu-hu' : 'en-us');
    return url.toString();
  }

  /**
   * Load the picker by POSTing the token to it from `doc`, the blank document
   * of the iframe or popup it is to run in, as Microsoft's samples do. The
   * form, token and all, goes with that document when the picker replaces it.
   */
  function postMsPickerForm(doc, token) {
    const form = doc.createElement('form');
    form.method = 'POST';
    form.action = msPickerAddress();
    const input = doc.createElement('input');
    input.type = 'hidden';
    input.name = 'access_token';
    input.value = token;
    form.appendChild(input);
    doc.body.appendChild(form);
    form.submit();
  }

  /** A fresh channel for every picker load, so an older one's messages are ignored. */
  function resetMsChannel(target) {
    if (msPort) {
      try {
        msPort.close();
      } catch (_) {
        // Already closed.
      }
    }
    msPort = null;
    msTarget = target;
    msChannelId = crypto.randomUUID();
  }

  function destroyMsFrame() {
    clearTimeout(msFrameTimer);
    showFrame(false);
    frameHost.replaceChildren();
  }

  function closeMsPopup() {
    clearInterval(msPopupTimer);
    if (msPopup && !msPopup.closed) {
      try {
        msPopup.close();
      } catch (_) {
        // Gone already.
      }
    }
    msPopup = null;
  }

  async function loadMsPickerInFrame() {
    setDetail('');
    setChoose('');
    setStatus('msLoadingPicker');
    const token = await msAccessToken(msPickerScope());
    if (finished) return;
    const frame = document.createElement('iframe');
    frame.title = t('msFrameTitle');
    frameHost.replaceChildren(frame);
    resetMsChannel(frame.contentWindow);
    postMsPickerForm(frame.contentDocument, token);
    clearTimeout(msFrameTimer);
    msFrameTimer = setTimeout(() => {
      if (msPort || finished || msTarget !== frame.contentWindow) return;
      // Usually a browser that keeps Microsoft's page out of frames on other sites.
      setStatus('msSlow');
      setChoose('msOpenWindow', openMsPickerWindow);
    }, MS_FRAME_TIMEOUT_MS);
  }

  /** On a click only: browsers allow a new window from a user's click. */
  function openMsPickerWindow() {
    const popup = window.open('', '', MS_POPUP_FEATURES);
    if (!popup) {
      setStatus('msPopupBlocked');
      setChoose('msOpenWindow', openMsPickerWindow);
      return;
    }
    destroyMsFrame();
    closeMsPopup();
    msPopup = popup;
    resetMsChannel(popup);
    setDetail('');
    setStatus('msWindowOpen');
    setChoose('msShowWindow', () => {
      if (msPopup && !msPopup.closed) msPopup.focus();
    });
    watchMsPopup(popup);
    msAccessToken(msPickerScope()).then((token) => {
      if (popup.closed || msPopup !== popup || finished) return;
      postMsPickerForm(popup.document, token);
    }, (error) => {
      showMsError(error);
    });
  }

  function watchMsPopup(popup) {
    clearInterval(msPopupTimer);
    msPopupTimer = setInterval(() => {
      if (!popup.closed) return;
      clearInterval(msPopupTimer);
      if (msPopup !== popup || finished) return;
      msPopup = null;
      resetMsChannel(null);
      setStatus('msWindowClosed');
      setChoose('msReopenWindow', openMsPickerWindow);
    }, 500);
  }

  function onMsWindowMessage(event) {
    if (!msTarget || event.source !== msTarget) return;
    let origin = null;
    try {
      origin = new URL(event.origin);
    } catch (_) {
      origin = null;
    }
    if (!origin || origin.protocol !== 'https:' || !MS_PICKER_HOST_RE.test(origin.hostname)) return;
    const data = event.data;
    if (!data || data.type !== 'initialize' || data.channelId !== msChannelId) return;
    const port = event.ports && event.ports[0];
    if (!port) return;
    // The picker says "initialize" again if it reloads; the newest port wins.
    if (msPort && msPort !== port) {
      try {
        msPort.close();
      } catch (_) {
        // Already closed.
      }
    }
    msPort = port;
    port.addEventListener('message', (e) => { onMsPortMessage(port, e); });
    port.start();
    port.postMessage({ type: 'activate' });
    clearTimeout(msFrameTimer);
    if (!msPopup) {
      setChoose('');
      showFrame(true);
      const frame = frameHost.querySelector('iframe');
      if (frame) frame.focus();
    }
  }

  async function onMsPortMessage(port, event) {
    if (port !== msPort) return;
    const message = event.data;
    if (!message || message.type !== 'command') return;   // notifications need no answer
    const id = message.id;
    const reply = (data) => {
      try {
        port.postMessage({ type: 'result', id, data });
      } catch (_) {
        // The picker is gone.
      }
    };
    // Every command is acknowledged first, as the protocol requires.
    try {
      port.postMessage({ type: 'acknowledge', id });
    } catch (_) {
      return;
    }
    const command = message.data || {};
    switch (command.command) {
      case 'authenticate': {
        const scope = msScopeFor(command);
        if (!scope) {
          reply({ result: 'error', error: { code: 'unableToObtainToken', message: 'This resource is not supported.' } });
          return;
        }
        try {
          reply({ result: 'token', token: await msAccessToken(scope) });
        } catch (_) {
          reply({ result: 'error', error: { code: 'unableToObtainToken', message: 'The sign-in has expired.' } });
        }
        return;
      }
      case 'pick': {
        reply({ result: 'success' });
        const items = Array.isArray(command.items) ? command.items.slice(0, MS_MAX_ITEMS) : [];
        closeMsPopup();
        deliver(items.map((item) => ({
          id: item && typeof item.id === 'string' ? item.id : '',
          driveId: item && item.parentReference && typeof item.parentReference.driveId === 'string'
            ? item.parentReference.driveId
            : '',
          name: item && typeof item.name === 'string' ? item.name : ''
        })));
        return;
      }
      case 'close':
        cancel();
        return;
      default:
        reply({ result: 'error', error: { code: 'unsupportedCommand', message: String(command.command || '') } });
    }
  }

  async function runOneDrive(answer) {
    msConfig = readMsConfig(answer);
    if (!msConfig) {
      fail('loadFailed');
      return;
    }
    saveInit(answer);
    window.addEventListener('message', onMsWindowMessage);
    // The extension closes this window once the files are handed over; a
    // separate picker window goes with it.
    window.addEventListener('pagehide', closeMsPopup);

    if (msAuthResponse) {
      setStatus('msSigningIn');
      try {
        await finishMsSignIn(msAuthResponse);
        await loadMsPickerInFrame();
      } catch (error) {
        showMsError(error);
      }
      return;
    }
    // Back here with no answer (Back on Microsoft's page, or a reload while
    // there): ask, rather than send the user straight back.
    if (readPendingSignIn()) {
      setStatus('msSignInPrompt');
      setChoose('msSignInButton', () => {
        beginMsSignIn().catch(() => fail('loadFailed'));
      });
      return;
    }
    await beginMsSignIn();
  }

  async function start() {
    applyLanguage();
    cancelBtn.addEventListener('click', () => { cancel(); });
    chooseBtn.addEventListener('click', () => {
      if (chooseAction) chooseAction();
    });

    if (!session || !PROVIDERS.includes(provider)) {
      fail('openFromExtension');
      return;
    }
    cancelBtn.hidden = false;

    // OneDrive asks once and keeps the answer across the trip to Microsoft's
    // sign-in and back: the extension answers only a few times per session.
    let config = provider === 'onedrive' ? loadSavedInit() : null;
    if (!config) {
      setStatus('connecting');
      config = await send({ action: 'hostedPickerInit' });
    }
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
        if (error === 'SIGN_IN_REQUIRED') {
          fail(provider === 'onedrive' ? 'signInRequiredOneDrive' : 'signInRequired');
        } else {
          fail('sessionInvalid');
        }
      }
      return;
    }

    try {
      if (config.provider === 'googledrive') {
        await runGoogle(config);
      } else if (config.provider === 'dropbox') {
        await runDropbox(config);
      } else if (config.provider === 'onedrive') {
        await runOneDrive(config);
      } else {
        fail('openFromExtension');
      }
    } catch (_) {
      fail('loadFailed');
    }
  }

  start();
})();
