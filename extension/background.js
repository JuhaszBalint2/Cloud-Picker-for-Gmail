// Cloud Picker for Gmail: background service worker.
//
// What it does:
//   - Signs in to Google Drive, Dropbox and OneDrive (chrome.identity web auth
//     flow; no client secret anywhere, PKCE where the service supports it).
//   - Opens the hosted picker page (the repository root, on GitHub Pages) in a
//     window of its own when the compose button asks for it, and answers that
//     page over externally_connectable: hostedPickerInit, hostedPickerResult,
//     hostedPickerCancel. Each window gets a random session nonce, valid for
//     that window only, a few inits and one result.
//   - Looks every chosen file up again with its own token (the page's word is
//     trusted for which files were chosen, nothing else), downloads it, and
//     hands the bytes to the compose window's content script, which attaches
//     them through Gmail's own attach button.
//
// Tokens live in chrome.storage.session (memory only, gone when the browser
// closes). The OAuth client ids and keys the user enters on the options page
// are public identifiers, kept in chrome.storage.local.
'use strict';

// The hosted page. It must match "externally_connectable" in manifest.json.
const PICKER_PAGE_URL = 'https://juhaszbalint2.github.io/Cloud-Picker-for-Gmail/';
const PROVIDERS = ['googledrive', 'dropbox', 'onedrive'];

// The hosted page keeps a OneDrive sign-in for as long as this lasts.
const SESSION_MAX_AGE_MS = 15 * 60 * 1000;
// A reload of the picker window asks again; more than this is not a reload.
const MAX_INITS_PER_SESSION = 3;
// The hosted page sends no more than this from one pick.
const MAX_ITEMS_PER_PICK = 500;
const MAX_ID_LENGTH = 1024;
// Above Gmail's own 25 MB (Gmail turns bigger attachments into Drive links by
// itself), but bounded: the whole file is held in memory on its way to Gmail.
const MAX_FILE_BYTES = 100 * 1024 * 1024;
// Bytes per message on the way to the content script, before base64.
const CHUNK_BYTES = 2 * 1024 * 1024;
// A finished download waits this long for the content script to collect it.
const TRANSFER_MAX_AGE_MS = 5 * 60 * 1000;
const TOKEN_MARGIN_MS = 2 * 60 * 1000;
const PROGRESS_INTERVAL_MS = 400;

// drive.file: the token reaches only the files the user picks in the Google
// Picker (the Picker grants them to this app, which is why it needs the app
// id), not the rest of the Drive.
const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const MS_SCOPE = 'Files.Read.All User.Read offline_access openid';
const MS_AUTHORITY = 'https://login.microsoftonline.com/common/oauth2/v2.0';
const MS_PERSONAL_PICKER_URL = 'https://onedrive.live.com/picker';
const GRAPH = 'https://graph.microsoft.com/v1.0';

// Google Docs, Sheets, Slides and Drawings have no bytes of their own: they
// are exported to the matching Office format (PDF for drawings).
const GOOGLE_EXPORTS = {
  'application/vnd.google-apps.document': {
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: '.docx'
  },
  'application/vnd.google-apps.spreadsheet': {
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: '.xlsx'
  },
  'application/vnd.google-apps.presentation': {
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ext: '.pptx'
  },
  'application/vnd.google-apps.drawing': { mimeType: 'application/pdf', ext: '.pdf' }
};

const MIME_BY_EXT = {
  pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', html: 'text/html', htm: 'text/html',
  json: 'application/json', xml: 'application/xml', zip: 'application/zip', rtf: 'application/rtf',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', heic: 'image/heic', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', mp4: 'video/mp4', mov: 'video/quicktime',
  doc: 'application/msword', xls: 'application/vnd.ms-excel', ppt: 'application/vnd.ms-powerpoint',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation'
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

class PickError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function base64Url(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomToken(byteCount) {
  return base64Url(crypto.getRandomValues(new Uint8Array(byteCount)));
}

async function pkcePair() {
  const verifier = randomToken(32);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function uiLocale() {
  return (chrome.i18n.getUILanguage() || '').toLowerCase().startsWith('hu') ? 'hu' : 'en';
}

function mimeFromName(name) {
  const dot = name.lastIndexOf('.');
  return (dot >= 0 && MIME_BY_EXT[name.slice(dot + 1).toLowerCase()]) || 'application/octet-stream';
}

/** Storage writes one at a time: every event runs in this one worker. */
let storageQueue = Promise.resolve();
function exclusive(fn) {
  const result = storageQueue.then(fn, fn);
  storageQueue = result.then(() => undefined, () => undefined);
  return result;
}

// ---------------------------------------------------------------------------
// Settings (public identifiers only)
// ---------------------------------------------------------------------------

const CONFIG_FIELDS = ['googleClientId', 'googleApiKey', 'googleAppId', 'dropboxAppKey', 'msClientId'];

async function getConfig() {
  const { config } = await chrome.storage.local.get('config');
  const clean = {};
  for (const field of CONFIG_FIELDS) {
    clean[field] = config && typeof config[field] === 'string' ? config[field].trim() : '';
  }
  return clean;
}

function providerConfigured(provider, config) {
  if (provider === 'googledrive') return !!(config.googleClientId && config.googleApiKey && config.googleAppId);
  if (provider === 'dropbox') return !!config.dropboxAppKey;
  if (provider === 'onedrive') return !!config.msClientId;
  return false;
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

async function readToken(provider) {
  const { tokens } = await chrome.storage.session.get('tokens');
  return (tokens && tokens[provider]) || null;
}

function writeToken(provider, token) {
  return exclusive(async () => {
    const { tokens } = await chrome.storage.session.get('tokens');
    const next = Object.assign({}, tokens);
    if (token) next[provider] = token;
    else delete next[provider];
    await chrome.storage.session.set({ tokens: next });
  });
}

function tokenFresh(token) {
  return !!(token && token.accessToken && token.expiresAt - TOKEN_MARGIN_MS > Date.now());
}

async function webAuth(url, interactive) {
  let answer;
  try {
    const details = { url: url.toString(), interactive };
    if (!interactive) {
      // Google answers a silent sign-in from a script on its page, after load.
      details.abortOnLoadForNonInteractive = false;
      details.timeoutMsForNonInteractive = 8000;
    }
    answer = await chrome.identity.launchWebAuthFlow(details);
  } catch (_) {
    // Closed by the user, or (not interactive) it would have needed the user.
    throw new PickError('SIGN_IN_REQUIRED');
  }
  if (!answer) throw new PickError('SIGN_IN_REQUIRED');
  return new URL(answer);
}

async function formPost(url, fields) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
      credentials: 'omit',
      cache: 'no-store'
    });
  } catch (_) {
    throw new PickError('NETWORK');
  }
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || typeof body.access_token !== 'string' || !body.access_token) {
    throw new PickError('SIGN_IN_REQUIRED');
  }
  return body;
}

function expiresAt(body) {
  const seconds = Number(body.expires_in);
  return Date.now() + (seconds > 0 ? seconds : 3600) * 1000;
}

async function googleSignIn(config, interactive, loginHint) {
  const state = randomToken(16);
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: config.googleClientId,
    response_type: 'token',
    redirect_uri: chrome.identity.getRedirectURL(),
    scope: GOOGLE_SCOPE,
    include_granted_scopes: 'true',
    state
  }).toString();
  if (loginHint) url.searchParams.set('login_hint', loginHint);
  const answer = new URLSearchParams((await webAuth(url, interactive)).hash.slice(1));
  if (answer.get('state') !== state || !answer.get('access_token')) throw new PickError('SIGN_IN_REQUIRED');
  const token = {
    accessToken: answer.get('access_token'),
    expiresAt: expiresAt({ expires_in: answer.get('expires_in') }),
    loginHint: loginHint || ''
  };
  await writeToken('googledrive', token);
  return token;
}

async function dropboxSignIn(config) {
  const { verifier, challenge } = await pkcePair();
  const state = randomToken(16);
  const redirectUri = chrome.identity.getRedirectURL();
  const url = new URL('https://www.dropbox.com/oauth2/authorize');
  url.search = new URLSearchParams({
    client_id: config.dropboxAppKey,
    response_type: 'code',
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    token_access_type: 'offline',
    state
  }).toString();
  const answer = (await webAuth(url, true)).searchParams;
  if (answer.get('state') !== state || !answer.get('code')) throw new PickError('SIGN_IN_REQUIRED');
  const body = await formPost('https://api.dropboxapi.com/oauth2/token', {
    grant_type: 'authorization_code',
    code: answer.get('code'),
    code_verifier: verifier,
    client_id: config.dropboxAppKey,
    redirect_uri: redirectUri
  });
  const token = { accessToken: body.access_token, expiresAt: expiresAt(body), refreshToken: body.refresh_token || '' };
  await writeToken('dropbox', token);
  return token;
}

async function msSignIn(config) {
  const { verifier, challenge } = await pkcePair();
  const state = randomToken(16);
  const redirectUri = chrome.identity.getRedirectURL();
  const url = new URL(`${MS_AUTHORITY}/authorize`);
  url.search = new URLSearchParams({
    client_id: config.msClientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    response_mode: 'query',
    scope: MS_SCOPE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
    state
  }).toString();
  const answer = (await webAuth(url, true)).searchParams;
  if (answer.get('state') !== state || !answer.get('code')) throw new PickError('SIGN_IN_REQUIRED');
  const body = await formPost(`${MS_AUTHORITY}/token`, {
    client_id: config.msClientId,
    grant_type: 'authorization_code',
    code: answer.get('code'),
    code_verifier: verifier,
    redirect_uri: redirectUri,
    scope: MS_SCOPE
  });
  const token = { accessToken: body.access_token, expiresAt: expiresAt(body), refreshToken: body.refresh_token || '' };
  await writeToken('onedrive', token);
  return token;
}

/** Dropbox and Microsoft: a new access token from the refresh token, or null. */
async function refreshToken(provider, config, token) {
  if (!token || !token.refreshToken) return null;
  try {
    const body = provider === 'dropbox'
      ? await formPost('https://api.dropboxapi.com/oauth2/token', {
        grant_type: 'refresh_token',
        refresh_token: token.refreshToken,
        client_id: config.dropboxAppKey
      })
      : await formPost(`${MS_AUTHORITY}/token`, {
        client_id: config.msClientId,
        grant_type: 'refresh_token',
        refresh_token: token.refreshToken,
        scope: MS_SCOPE
      });
    const next = {
      accessToken: body.access_token,
      expiresAt: expiresAt(body),
      // Microsoft hands out a new refresh token each time; Dropbox keeps the old one.
      refreshToken: body.refresh_token || token.refreshToken
    };
    await writeToken(provider, next);
    return next;
  } catch (error) {
    if (error.code === 'NETWORK') throw error;
    await writeToken(provider, null);
    return null;
  }
}

/** One token request per provider at a time, so two picks never race a refresh. */
const tokenRequests = new Map();

function accessToken(provider, options) {
  const pending = tokenRequests.get(provider) || Promise.resolve();
  const run = () => obtainToken(provider, options || {});
  const result = pending.then(run, run);
  tokenRequests.set(provider, result.then(() => undefined, () => undefined));
  return result;
}

async function obtainToken(provider, { interactive, loginHint }) {
  const config = await getConfig();
  if (!providerConfigured(provider, config)) throw new PickError('NOT_CONFIGURED');
  const current = await readToken(provider);
  if (tokenFresh(current) && (provider !== 'googledrive' || !loginHint || current.loginHint === loginHint)) {
    return current.accessToken;
  }
  if (provider === 'googledrive') {
    try {
      return (await googleSignIn(config, false, loginHint)).accessToken;
    } catch (error) {
      if (!interactive) throw error;
      return (await googleSignIn(config, true, loginHint)).accessToken;
    }
  }
  const refreshed = await refreshToken(provider, config, current);
  if (refreshed) return refreshed.accessToken;
  if (!interactive) throw new PickError('SIGN_IN_REQUIRED');
  const token = provider === 'dropbox' ? await dropboxSignIn(config) : await msSignIn(config);
  return token.accessToken;
}

/** A fetch with this provider's token; one retry with a renewed token on 401. */
async function apiFetch(provider, url, init) {
  for (let attempt = 0; ; attempt++) {
    const token = await accessToken(provider, { interactive: false });
    const headers = Object.assign({}, (init && init.headers) || {}, { Authorization: `Bearer ${token}` });
    let res;
    try {
      res = await fetch(url, Object.assign({}, init, { headers, credentials: 'omit', cache: 'no-store' }));
    } catch (_) {
      throw new PickError('NETWORK');
    }
    if (res.status === 401 && attempt === 0) {
      const stale = await readToken(provider);
      if (stale && stale.accessToken === token) {
        await writeToken(provider, Object.assign({}, stale, { expiresAt: 0 }));
      }
      continue;
    }
    return res;
  }
}

// ---------------------------------------------------------------------------
// Picker sessions
// ---------------------------------------------------------------------------

async function readSessions() {
  const { sessions } = await chrome.storage.session.get('sessions');
  const now = Date.now();
  const live = {};
  for (const [nonce, session] of Object.entries(sessions || {})) {
    if (session && now - session.createdAt < SESSION_MAX_AGE_MS) live[nonce] = session;
  }
  return live;
}

function updateSessions(fn) {
  return exclusive(async () => {
    const sessions = await readSessions();
    const result = fn(sessions);
    await chrome.storage.session.set({ sessions });
    return result;
  });
}

/** OneDrive: which kind of account, and where its picker lives. */
async function oneDriveFacts() {
  const [driveRes, meRes] = await Promise.all([
    apiFetch('onedrive', `${GRAPH}/me/drive?$select=driveType,webUrl`),
    apiFetch('onedrive', `${GRAPH}/me?$select=userPrincipalName,mail`)
  ]);
  if (!driveRes.ok || !meRes.ok) throw new PickError('PROVIDER_ERROR');
  const drive = await driveRes.json();
  const me = await meRes.json();
  const kind = drive.driveType === 'personal' ? 'personal' : 'business';
  let pickerUrl = MS_PERSONAL_PICKER_URL;
  if (kind === 'business') {
    const origin = new URL(drive.webUrl).origin;
    if (!/^https:\/\/[a-z0-9-]+\.sharepoint\.com$/i.test(origin)) throw new PickError('PROVIDER_ERROR');
    pickerUrl = `${origin}/_layouts/15/FilePicker.aspx`;
  }
  return { kind, pickerUrl, loginHint: String(me.mail || me.userPrincipalName || '').slice(0, 320) };
}

async function openPicker(message, sender) {
  const provider = message.provider;
  if (!PROVIDERS.includes(provider)) return { ok: false, error: 'BAD_REQUEST' };
  if (typeof message.composeId !== 'string' || !message.composeId) return { ok: false, error: 'BAD_REQUEST' };
  const loginHint = typeof message.accountHint === 'string' && /^[^\s@]+@[^\s@]+$/.test(message.accountHint)
    ? message.accountHint.slice(0, 320)
    : '';

  // Signed in before the window opens, so a pick never ends at a sign-in.
  await accessToken(provider, { interactive: true, loginHint: provider === 'googledrive' ? loginHint : '' });
  const ms = provider === 'onedrive' ? await oneDriveFacts() : null;

  const nonce = randomToken(24);
  const hash = new URLSearchParams({ session: nonce, provider, ext: chrome.runtime.id });
  const placement = { width: 1080, height: 720 };
  try {
    const parent = await chrome.windows.get(sender.tab.windowId);
    placement.left = Math.max(0, Math.round(parent.left + (parent.width - placement.width) / 2));
    placement.top = Math.max(0, Math.round(parent.top + (parent.height - placement.height) / 2));
  } catch (_) {
    // The browser picks a place.
  }
  // Stored before the window opens: its page may ask before create() returns.
  await updateSessions((sessions) => {
    sessions[nonce] = {
      provider,
      tabId: sender.tab.id,
      frameId: sender.frameId || 0,
      composeId: message.composeId,
      windowId: null,
      createdAt: Date.now(),
      inits: 0,
      ms
    };
  });
  let win;
  try {
    win = await chrome.windows.create(Object.assign({
      url: `${PICKER_PAGE_URL}#${hash}`,
      type: 'popup',
      focused: true
    }, placement));
  } catch (_) {
    await updateSessions((sessions) => { delete sessions[nonce]; });
    return { ok: false, error: 'WINDOW_FAILED' };
  }
  await updateSessions((sessions) => {
    if (sessions[nonce]) sessions[nonce].windowId = win.id;
  });
  return { ok: true };
}

function closeWindowSoon(windowId) {
  // A moment for the page to show "Done" and for the answer to reach it.
  setTimeout(() => {
    chrome.windows.remove(windowId).catch(() => {});
  }, 400);
}

/** The session a message from the hosted page belongs to, or null. */
function sessionFor(sessions, message, sender) {
  if (!message || typeof message.session !== 'string') return null;
  const session = Object.prototype.hasOwnProperty.call(sessions, message.session) ? sessions[message.session] : null;
  if (!session || !sender.tab) return null;
  // Only from the window opened for this session (windowId is null for a
  // moment while it opens; the tab's window is then the newest one).
  if (session.windowId !== null && sender.tab.windowId !== session.windowId) return null;
  return session;
}

async function handleExternal(message, sender) {
  if (typeof sender.url !== 'string' || !sender.url.startsWith(PICKER_PAGE_URL)) {
    return { ok: false, error: 'SESSION_INVALID' };
  }
  const action = message && message.action;

  if (action === 'hostedPickerInit') {
    const session = await updateSessions((sessions) => {
      const found = sessionFor(sessions, message, sender);
      if (!found || found.inits >= MAX_INITS_PER_SESSION) return null;
      found.inits += 1;
      if (found.windowId === null) found.windowId = sender.tab.windowId;
      return Object.assign({}, found);
    });
    if (!session) return { ok: false, error: 'SESSION_INVALID' };
    const config = await getConfig();
    const answer = { ok: true, provider: session.provider, locale: uiLocale() };
    try {
      if (session.provider === 'googledrive') {
        answer.googleToken = await accessToken('googledrive', { interactive: false });
        answer.googleApiKey = config.googleApiKey;
        answer.googleAppId = config.googleAppId;
      } else if (session.provider === 'dropbox') {
        answer.dropboxAppKey = config.dropboxAppKey;
      } else {
        answer.msClientId = config.msClientId;
        answer.msKind = session.ms.kind;
        answer.msPickerUrl = session.ms.pickerUrl;
        answer.msLoginHint = session.ms.loginHint;
      }
    } catch (_) {
      return { ok: false, error: 'SIGN_IN_REQUIRED' };
    }
    return answer;
  }

  if (action === 'hostedPickerResult') {
    const items = sanitizeItems(message.items);
    if (!items) return { ok: false, error: 'BAD_REQUEST' };
    // Single use: taken out before anything else can see it.
    const session = await updateSessions((sessions) => {
      const found = sessionFor(sessions, message, sender);
      if (found) delete sessions[message.session];
      return found;
    });
    if (!session) return { ok: false, error: 'SESSION_INVALID' };
    closeWindowSoon(sender.tab.windowId);
    processPick(session, items).catch(() => {
      tellTab(session, { action: 'transferFailed', failed: [] });
    });
    return { ok: true };
  }

  if (action === 'hostedPickerCancel') {
    const session = await updateSessions((sessions) => {
      const found = sessionFor(sessions, message, sender);
      if (found) delete sessions[message.session];
      return found;
    });
    if (!session) return { ok: false, error: 'SESSION_INVALID' };
    closeWindowSoon(sender.tab.windowId);
    return { ok: true };
  }

  return { ok: false, error: 'BAD_REQUEST' };
}

function sanitizeItems(items) {
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_ITEMS_PER_PICK) return null;
  const clean = [];
  for (const item of items) {
    if (!item || typeof item.id !== 'string' || !item.id || item.id.length > MAX_ID_LENGTH) return null;
    clean.push({
      id: item.id,
      name: typeof item.name === 'string' ? item.name.slice(0, 255) : '',
      driveId: typeof item.driveId === 'string' && item.driveId.length <= MAX_ID_LENGTH ? item.driveId : ''
    });
  }
  return clean;
}

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------

/** Where to download a chosen file from, looked up with this extension's own token. */
async function resolveFile(provider, item) {
  if (provider === 'googledrive') {
    const id = encodeURIComponent(item.id);
    const metaRes = await apiFetch('googledrive',
      `https://www.googleapis.com/drive/v3/files/${id}?fields=id,name,mimeType,size&supportsAllDrives=true`);
    if (metaRes.status === 404 || metaRes.status === 403) throw new PickError('NOT_FOUND');
    if (!metaRes.ok) throw new PickError('PROVIDER_ERROR');
    const meta = await metaRes.json();
    if (meta.mimeType === 'application/vnd.google-apps.folder') throw new PickError('FOLDER');
    const exported = GOOGLE_EXPORTS[meta.mimeType];
    if (exported) {
      const name = meta.name.toLowerCase().endsWith(exported.ext) ? meta.name : meta.name + exported.ext;
      return {
        name,
        mimeType: exported.mimeType,
        size: 0,
        request: () => apiFetch('googledrive',
          `https://www.googleapis.com/drive/v3/files/${id}/export?mimeType=${encodeURIComponent(exported.mimeType)}`)
      };
    }
    if (String(meta.mimeType).startsWith('application/vnd.google-apps.')) throw new PickError('UNSUPPORTED');
    return {
      name: meta.name,
      mimeType: meta.mimeType || mimeFromName(meta.name),
      size: Number(meta.size) || 0,
      request: () => apiFetch('googledrive',
        `https://www.googleapis.com/drive/v3/files/${id}?alt=media&supportsAllDrives=true`)
    };
  }

  if (provider === 'dropbox') {
    // Only ASCII in an HTTP header; a Dropbox id ("id:...") always is.
    if (!/^[\x20-\x7e]+$/.test(item.id)) throw new PickError('NOT_FOUND');
    const metaRes = await apiFetch('dropbox', 'https://api.dropboxapi.com/2/files/get_metadata', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: item.id })
    });
    if (metaRes.status === 409) throw new PickError('NOT_FOUND');
    if (!metaRes.ok) throw new PickError('PROVIDER_ERROR');
    const meta = await metaRes.json();
    if (meta['.tag'] === 'folder') throw new PickError('FOLDER');
    if (meta['.tag'] !== 'file') throw new PickError('UNSUPPORTED');
    return {
      name: meta.name,
      mimeType: mimeFromName(meta.name),
      size: Number(meta.size) || 0,
      request: () => apiFetch('dropbox', 'https://content.dropboxapi.com/2/files/download', {
        method: 'POST',
        headers: { 'Dropbox-API-Arg': JSON.stringify({ path: item.id }) }
      })
    };
  }

  // OneDrive: an id is unique only within its drive.
  const path = item.driveId
    ? `/drives/${encodeURIComponent(item.driveId)}/items/${encodeURIComponent(item.id)}`
    : `/me/drive/items/${encodeURIComponent(item.id)}`;
  const metaRes = await apiFetch('onedrive', `${GRAPH}${path}`);
  if (metaRes.status === 404 || metaRes.status === 403) throw new PickError('NOT_FOUND');
  if (!metaRes.ok) throw new PickError('PROVIDER_ERROR');
  const meta = await metaRes.json();
  if (meta.folder) throw new PickError('FOLDER');
  const downloadUrl = meta['@microsoft.graph.downloadUrl'];
  if (!meta.file || typeof downloadUrl !== 'string' || !downloadUrl.startsWith('https://')) {
    throw new PickError('UNSUPPORTED');
  }
  return {
    name: meta.name,
    mimeType: (meta.file && meta.file.mimeType) || mimeFromName(meta.name),
    size: Number(meta.size) || 0,
    // A pre-authenticated address: no token goes with it.
    request: async () => {
      try {
        return await fetch(downloadUrl, { credentials: 'omit', cache: 'no-store' });
      } catch (_) {
        throw new PickError('NETWORK');
      }
    }
  };
}

/** The whole body, refusing more than MAX_FILE_BYTES; onBytes reports progress. */
async function readBody(res, onBytes) {
  const declared = Number(res.headers.get('Content-Length'));
  if (declared > MAX_FILE_BYTES) throw new PickError('TOO_LARGE');
  const reader = res.body.getReader();
  const parts = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_FILE_BYTES) {
      reader.cancel().catch(() => {});
      throw new PickError('TOO_LARGE');
    }
    parts.push(value);
    onBytes(value.length);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

// transferId → { tabId, files: [{ name, mimeType, bytes }], timer }
const transfers = new Map();

function tellTab(session, message) {
  return chrome.tabs.sendMessage(session.tabId, Object.assign({ composeId: session.composeId }, message),
    { frameId: session.frameId }).catch(() => {});
}

async function processPick(session, items) {
  const provider = session.provider;
  const count = items.length;
  await tellTab(session, { action: 'transferStart', provider, count });

  const files = [];
  const failed = [];
  let lastProgress = 0;
  for (let index = 0; index < count; index++) {
    const item = items[index];
    try {
      const target = await resolveFile(provider, item);
      if (target.size > MAX_FILE_BYTES) throw new PickError('TOO_LARGE');
      const res = await target.request();
      if (res.status === 404 || res.status === 403) throw new PickError('NOT_FOUND');
      if (!res.ok || !res.body) throw new PickError('PROVIDER_ERROR');
      let loaded = 0;
      const bytes = await readBody(res, (n) => {
        loaded += n;
        const now = Date.now();
        // Each message also keeps this worker awake through a long download.
        if (now - lastProgress >= PROGRESS_INTERVAL_MS) {
          lastProgress = now;
          tellTab(session, {
            action: 'transferProgress', index, count, name: target.name, loaded, total: target.size
          });
        }
      });
      files.push({ name: target.name, mimeType: target.mimeType, bytes });
    } catch (error) {
      failed.push({ name: item.name || item.id, reason: error instanceof PickError ? error.code : 'PROVIDER_ERROR' });
    }
  }

  if (files.length === 0) {
    await tellTab(session, { action: 'transferFailed', failed });
    return;
  }
  const transferId = randomToken(16);
  const timer = setTimeout(() => transfers.delete(transferId), TRANSFER_MAX_AGE_MS);
  transfers.set(transferId, { tabId: session.tabId, files, timer });
  await tellTab(session, {
    action: 'transferReady',
    transferId,
    files: files.map((f) => ({
      name: f.name,
      mimeType: f.mimeType,
      size: f.bytes.length,
      chunkCount: Math.max(1, Math.ceil(f.bytes.length / CHUNK_BYTES))
    })),
    failed
  });
}

function readChunk(message, sender) {
  const transfer = transfers.get(message.transferId);
  if (!transfer || !sender.tab || transfer.tabId !== sender.tab.id) return { ok: false, error: 'TRANSFER_GONE' };
  const file = transfer.files[message.file];
  const start = Number(message.chunk) * CHUNK_BYTES;
  if (!file || !Number.isInteger(message.chunk) || message.chunk < 0 || (start >= file.bytes.length && start > 0)) {
    return { ok: false, error: 'BAD_REQUEST' };
  }
  return { ok: true, data: toBase64(file.bytes.subarray(start, start + CHUNK_BYTES)) };
}

function releaseTransfer(message, sender) {
  const transfer = transfers.get(message.transferId);
  if (transfer && sender.tab && transfer.tabId === sender.tab.id) {
    clearTimeout(transfer.timer);
    transfers.delete(message.transferId);
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

async function providerStatus() {
  const config = await getConfig();
  const status = {};
  for (const provider of PROVIDERS) {
    const token = await readToken(provider);
    status[provider] = {
      configured: providerConfigured(provider, config),
      signedIn: !!(token && (tokenFresh(token) || token.refreshToken))
    };
  }
  return status;
}

function isGmailSender(sender) {
  return !!(sender.tab && typeof sender.url === 'string' && sender.url.startsWith('https://mail.google.com/'));
}

function isExtensionPage(sender) {
  return typeof sender.url === 'string' && sender.url.startsWith(chrome.runtime.getURL(''));
}

async function handleInternal(message, sender) {
  if (sender.id !== chrome.runtime.id || !message) return { ok: false, error: 'BAD_REQUEST' };
  const action = message.action;
  if (isGmailSender(sender)) {
    if (action === 'getProviders') return { ok: true, providers: await providerStatus(), locale: uiLocale() };
    if (action === 'openPicker') return openPicker(message, sender);
    if (action === 'readChunk') return readChunk(message, sender);
    if (action === 'releaseTransfer') return releaseTransfer(message, sender);
    if (action === 'openOptions') {
      await chrome.runtime.openOptionsPage();
      return { ok: true };
    }
  }
  if (isExtensionPage(sender)) {
    if (action === 'getStatus') {
      return {
        ok: true,
        providers: await providerStatus(),
        redirectUri: chrome.identity.getRedirectURL(),
        pickerPage: PICKER_PAGE_URL
      };
    }
    if (action === 'signIn' && PROVIDERS.includes(message.provider)) {
      await accessToken(message.provider, { interactive: true });
      return { ok: true };
    }
    if (action === 'signOut' && PROVIDERS.includes(message.provider)) {
      await writeToken(message.provider, null);
      return { ok: true };
    }
  }
  return { ok: false, error: 'BAD_REQUEST' };
}

function answer(promise, sendResponse) {
  promise.then(sendResponse, (error) => {
    sendResponse({ ok: false, error: error instanceof PickError ? error.code : 'FAILED' });
  });
  return true;   // the answer comes later
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  return answer(handleInternal(message, sender), sendResponse);
});

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  return answer(handleExternal(message, sender), sendResponse);
});

// A picker window closed by hand ends its session.
chrome.windows.onRemoved.addListener((windowId) => {
  updateSessions((sessions) => {
    for (const [nonce, session] of Object.entries(sessions)) {
      if (session.windowId === windowId) delete sessions[nonce];
    }
  }).catch(() => {});
});

chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason !== 'install') return;
  const config = await getConfig();
  if (!PROVIDERS.some((p) => providerConfigured(p, config))) chrome.runtime.openOptionsPage();
});
