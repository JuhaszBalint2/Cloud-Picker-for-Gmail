// Cloud Picker for Gmail: settings.
//
// The ids and keys entered here are public identifiers (OAuth client ids, a
// browser API key restricted to the picker page, a Dropbox app key): none of
// them is a secret, and no secret is ever asked for. Saved in
// chrome.storage.local, read by the background worker.
'use strict';

(function () {
  const FIELDS = ['googleClientId', 'googleApiKey', 'googleAppId', 'dropboxAppKey', 'msClientId'];

  const STRINGS = {
    en: {
      title: 'Cloud Picker for Gmail',
      intro: 'Attach files from Google Drive, Dropbox and OneDrive with the cloud button next to the paperclip in Gmail\'s compose window. Set up the services you want to use below; the others stay hidden.',
      registerTitle: 'Addresses to register',
      registerIntro: 'Each service needs these addresses in its app registration (details in the README).',
      redirectUri: 'Sign-in redirect URI (Google, Dropbox, and Microsoft as a single-page application)',
      pickerPage: 'Picker page (Microsoft single-page application redirect URI)',
      pickerOrigin: 'Picker page origin (Google API key referrer and JavaScript origin; Dropbox Chooser domain)',
      googleClientId: 'OAuth client ID (web application)',
      googleApiKey: 'API key',
      googleAppId: 'Project number (app ID)',
      googleHint: 'Google Cloud console: enable the Google Drive API and the Google Picker API. The project number is on the project\'s dashboard.',
      dropboxAppKey: 'App key',
      dropboxHint: 'Dropbox App Console: scopes files.metadata.read and files.content.read; add the redirect URI and the picker page\'s domain as a Chooser domain.',
      msClientId: 'Application (client) ID',
      msHint: 'Microsoft Entra admin center: supported account types "any organizational directory and personal Microsoft accounts"; both addresses above as single-page application redirect URIs; delegated permissions Files.Read.All and User.Read (and SharePoint AllSites.Read for work accounts).',
      signIn: 'Sign in',
      signOut: 'Sign out',
      save: 'Save',
      saved: 'Saved.',
      notConfigured: 'not set up',
      signedIn: 'signed in',
      signedOut: 'ready, not signed in',
      signInFailed: 'sign-in did not finish'
    },
    hu: {
      title: 'Cloud Picker for Gmail',
      intro: 'Fájlok csatolása a Google Drive-ból, a Dropboxból és a OneDrive-ból a Gmail levélíró ablakában, a gemkapocs melletti felhő gombbal. Alább állítsa be a használni kívánt szolgáltatásokat; a többi rejtve marad.',
      registerTitle: 'Regisztrálandó címek',
      registerIntro: 'Minden szolgáltatás alkalmazásregisztrációjában szerepelnie kell ezeknek a címeknek (részletek a README-ben).',
      redirectUri: 'Bejelentkezési átirányítási URI (Google, Dropbox, valamint Microsoft egyoldalas alkalmazásként)',
      pickerPage: 'Választóoldal (Microsoft egyoldalas alkalmazás átirányítási URI)',
      pickerOrigin: 'A választóoldal forrása (Google API-kulcs hivatkozója és JavaScript-forrása; Dropbox Chooser-tartomány)',
      googleClientId: 'OAuth-ügyfél-azonosító (webalkalmazás)',
      googleApiKey: 'API-kulcs',
      googleAppId: 'Projektszám (alkalmazásazonosító)',
      googleHint: 'Google Cloud konzol: engedélyezze a Google Drive API-t és a Google Picker API-t. A projektszám a projekt irányítópultján található.',
      dropboxAppKey: 'Alkalmazáskulcs',
      dropboxHint: 'Dropbox App Console: files.metadata.read és files.content.read hatókör; adja hozzá az átirányítási URI-t, és a választóoldal tartományát Chooser-tartományként.',
      msClientId: 'Alkalmazás (ügyfél) azonosítója',
      msHint: 'Microsoft Entra Felügyeleti központ: támogatott fióktípus „bármely szervezeti címtár és személyes Microsoft-fiókok”; a fenti két cím egyoldalas alkalmazás átirányítási URI-ként; delegált engedélyek: Files.Read.All és User.Read (munkahelyi fiókokhoz SharePoint AllSites.Read is).',
      signIn: 'Bejelentkezés',
      signOut: 'Kijelentkezés',
      save: 'Mentés',
      saved: 'Mentve.',
      notConfigured: 'nincs beállítva',
      signedIn: 'bejelentkezve',
      signedOut: 'kész, nincs bejelentkezve',
      signInFailed: 'a bejelentkezés nem fejeződött be'
    }
  };

  const lang = (chrome.i18n.getUILanguage() || '').toLowerCase().startsWith('hu') ? 'hu' : 'en';
  const t = (key) => (STRINGS[lang] || STRINGS.en)[key] || STRINGS.en[key] || '';

  document.documentElement.lang = lang;
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });

  const form = document.getElementById('form');
  const savedEl = document.getElementById('saved');

  function send(message) {
    return chrome.runtime.sendMessage(message).catch(() => ({ ok: false }));
  }

  async function refreshStatus(failedProvider) {
    const status = await send({ action: 'getStatus' });
    if (!status.ok) return;
    document.getElementById('redirectUri').textContent = status.redirectUri;
    document.getElementById('pickerPage').textContent = status.pickerPage;
    document.getElementById('pickerOrigin').textContent = new URL(status.pickerPage).origin;
    document.querySelectorAll('[data-provider]').forEach((section) => {
      const provider = section.dataset.provider;
      const info = status.providers[provider];
      const el = section.querySelector('[data-status]');
      let key = !info.configured ? 'notConfigured' : info.signedIn ? 'signedIn' : 'signedOut';
      if (failedProvider === provider) key = 'signInFailed';
      el.textContent = t(key);
      el.className = `status${key === 'signedIn' ? ' ok' : key === 'signInFailed' ? ' error' : ''}`;
      section.querySelector('[data-sign-in]').disabled = !info.configured;
      section.querySelector('[data-sign-out]').disabled = !info.signedIn;
    });
  }

  async function load() {
    const { config } = await chrome.storage.local.get('config');
    for (const field of FIELDS) {
      form.elements[field].value = (config && config[field]) || '';
    }
    await refreshStatus();
  }

  async function save() {
    const config = {};
    for (const field of FIELDS) config[field] = form.elements[field].value.trim();
    const { config: previous } = await chrome.storage.local.get('config');
    await chrome.storage.local.set({ config });
    // A token belongs to the client it was issued to.
    const clientOf = {
      googledrive: 'googleClientId', dropbox: 'dropboxAppKey', onedrive: 'msClientId'
    };
    for (const [provider, field] of Object.entries(clientOf)) {
      if (((previous && previous[field]) || '') !== config[field]) await send({ action: 'signOut', provider });
    }
    savedEl.textContent = t('saved');
    setTimeout(() => { savedEl.textContent = ''; }, 3000);
    await refreshStatus();
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    save();
  });

  document.querySelectorAll('[data-provider]').forEach((section) => {
    const provider = section.dataset.provider;
    section.querySelector('[data-sign-in]').addEventListener('click', async () => {
      await save();
      const answer = await send({ action: 'signIn', provider });
      await refreshStatus(answer.ok ? '' : provider);
    });
    section.querySelector('[data-sign-out]').addEventListener('click', async () => {
      await send({ action: 'signOut', provider });
      await refreshStatus();
    });
  });

  load();
})();
