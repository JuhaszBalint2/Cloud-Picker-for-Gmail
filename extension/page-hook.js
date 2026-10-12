// Cloud Picker for Gmail: runs in Gmail's own page (the MAIN world).
//
// Gmail attaches files through a hidden <input type="file"> that its paperclip
// button clicks. To attach the files chosen in the cloud picker the same way,
// with Gmail's own upload, size checks and attachment chips, the content
// script hands the files over here ("arm"), then presses that compose window's
// paperclip button. When Gmail then clicks its file input, this hook fills the
// input instead of opening the file dialog and tells Gmail it changed.
//
// Armed for a few seconds and for one input only; any other click on any
// other element behaves exactly as before. Nothing here talks to the
// extension: the files are already on their way into Gmail.
'use strict';

(function () {
  const ARM_TIMEOUT_MS = 5000;
  const INTERCEPT_KEY = '__cloudPickerInterceptFileInput';

  function isFileInput(el) {
    return !!el && el.tagName === 'INPUT' && String(el.type).toLowerCase() === 'file';
  }

  /** Gmail's code may run in a same-origin frame; such frames defer to the top window's hook. */
  function patch(intercept) {
    const nativeClick = HTMLElement.prototype.click;
    HTMLElement.prototype.click = function () {
      if (isFileInput(this) && intercept(this)) return undefined;
      return nativeClick.apply(this, arguments);
    };
    const nativeShowPicker = HTMLInputElement.prototype.showPicker;
    if (typeof nativeShowPicker === 'function') {
      HTMLInputElement.prototype.showPicker = function () {
        if (isFileInput(this) && intercept(this)) return undefined;
        return nativeShowPicker.apply(this, arguments);
      };
    }
  }

  if (window.top !== window) {
    patch((input) => {
      try {
        const top = window.top;
        return !!(top[INTERCEPT_KEY] && top[INTERCEPT_KEY](input));
      } catch (_) {
        return false;   // another origin: not Gmail's code
      }
    });
    return;
  }

  let armed = null;   // { token, files, until }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (!data || typeof data !== 'object' || typeof data.token !== 'string') return;
    if (data.cloudPicker === 'arm' && Array.isArray(data.files) && data.files.length
        && data.files.every((f) => f instanceof File)) {
      armed = { token: data.token, files: data.files, until: Date.now() + ARM_TIMEOUT_MS };
      window.postMessage({ cloudPicker: 'armed', token: data.token }, location.origin);
    } else if (data.cloudPicker === 'disarm' && armed && armed.token === data.token) {
      armed = null;
    }
  });

  function intercept(input) {
    if (!armed || Date.now() > armed.until) {
      armed = null;
      return false;
    }
    const { token, files } = armed;
    armed = null;
    try {
      const transfer = new DataTransfer();
      files.forEach((file) => transfer.items.add(file));
      input.files = transfer.files;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      window.postMessage({ cloudPicker: 'attached', token }, location.origin);
    } catch (_) {
      window.postMessage({ cloudPicker: 'attachFailed', token }, location.origin);
    }
    return true;
  }

  Object.defineProperty(window, INTERCEPT_KEY, { value: intercept });
  patch(intercept);
})();
