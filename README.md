# Cloud Picker for Gmail

Attach files from **Google Drive**, **Dropbox** and **OneDrive** straight from Gmail's
compose window. A cloud button sits next to Gmail's paperclip in every compose window:
new messages, pop-outs, and inline Reply / Reply all / Forward.

This repository has two parts:

| Path | What it is |
| --- | --- |
| `extension/` | The browser extension (Chrome / Edge, Manifest V3). No build step. |
| `index.html`, `picker.js`, `style.css` | The hosted picker page, served by GitHub Pages at `https://juhaszbalint2.github.io/Cloud-Picker-for-Gmail/`. Google's, Dropbox's and Microsoft's own pickers only run on a website, so the extension opens this page in a window of its own. |

## Install

1. Open `chrome://extensions` (or `edge://extensions`) and turn on **Developer mode**.
2. Click **Load unpacked** and choose the `extension` folder.
3. The settings page opens. Set up at least one service (below), then **reload Gmail**.

The extension ID is always `lpopajldbemheobeghoaphkhkbpcplne`, because `manifest.json` pins a
public key. Every redirect URI below depends on it.

The picker page must be live on GitHub Pages: **Settings → Pages → Deploy from a branch →
`main` / root**.

## Setting up the services

The settings page lists the exact addresses to register. They are:

- **Sign-in redirect URI:** `https://lpopajldbemheobeghoaphkhkbpcplne.chromiumapp.org/`
- **Picker page:** `https://juhaszbalint2.github.io/Cloud-Picker-for-Gmail/`
- **Picker page origin:** `https://juhaszbalint2.github.io`

Only public identifiers are entered: client IDs, an API key and an app key. Nothing on the
settings page is a secret, and no client secret is used anywhere.

### Google Drive

In the [Google Cloud console](https://console.cloud.google.com/):

1. Enable the **Google Drive API** and the **Google Picker API**.
2. Set up the **OAuth consent screen** with the scope `.../auth/drive.file`. Add yourself as a
   test user while the app is in Testing.
3. Create an **OAuth client ID** of type **Web application**:
   - Authorized redirect URI: the sign-in redirect URI above.
   - Authorized JavaScript origin: the picker page origin.
4. Create an **API key** and restrict it to the Google Picker API and the HTTP referrer
   `https://juhaszbalint2.github.io/*`.
5. On the settings page, enter the client ID, the API key, and the **project number** (the
   project dashboard shows it). The project number is the Picker's app ID: it is what lets the
   `drive.file` token open the files you pick.

Google Docs, Sheets and Slides are attached as `.docx`, `.xlsx` and `.pptx`, and Drawings as
`.pdf`.

### Dropbox

In the [Dropbox App Console](https://www.dropbox.com/developers/apps):

1. Create an app with **Scoped access**. On the **Permissions** tab, tick
   `files.metadata.read` and `files.content.read`.
2. On the **Settings** tab:
   - Add the sign-in redirect URI under **OAuth 2 → Redirect URIs**.
   - Add `juhaszbalint2.github.io` under **Chooser / Saver / Embedder domains**.
3. Enter the **App key** on the settings page.

### OneDrive (personal, work or school)

In the [Microsoft Entra admin center](https://entra.microsoft.com/) → App registrations:

1. Create a new registration. For supported account types, choose **Accounts in any
   organizational directory and personal Microsoft accounts**.
2. Under **Authentication**, add the platform **Single-page application** with **both** the
   sign-in redirect URI and the picker page address.
3. Under **API permissions**, add the delegated Microsoft Graph permissions `Files.Read.All`
   and `User.Read`. For work and school accounts, also add the delegated SharePoint permission
   `AllSites.Read`.
4. Enter the **Application (client) ID** on the settings page.

## How it works

1. You click the cloud button and choose a service. The extension signs in if needed, then
   opens the picker page in a window with a one-time session in the URL fragment.
2. The page asks the extension for that service's public IDs and shows the service's own
   picker. It sends back only the IDs of the files you chose. The extension accepts messages
   only from that page, only for that session, and only from that window.
3. The extension looks each file up again with its own token and downloads it. Limits:
   100 MB per file, and folders are skipped.
4. The files are handed to Gmail through Gmail's own paperclip. `page-hook.js` fills in the
   file input Gmail opens. Gmail uploads them exactly as if you had chosen them from your
   computer, so its size rules apply: past 25 MB, Gmail offers a Drive link.

Tokens are kept in memory only (`chrome.storage.session`), so you sign in again after
restarting the browser.

## Troubleshooting: no button in the compose window

- **Reload Gmail** after installing or updating the extension. Tabs that were already open
  don't get the new code.
- On `chrome://extensions`, open the extension's **Details** and check **Site access**. It must
  allow `mail.google.com`.
- Check for errors on the extension's card on `chrome://extensions`, and in the Gmail tab's
  console (F12).
- The button goes right after Gmail's paperclip (`[command="Files"]`). If Gmail ever renames
  that element, the button goes at the end of the compose toolbar row instead.
