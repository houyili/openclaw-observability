// Pure function: maps a /healthz response payload → the text + class
// that the top-right refresh indicator should display.
//
// This file is loaded as a CLASSIC <script> by the browser, NOT an ES
// module — it just attaches the function to the global `window` so
// `app.js` can call it. Node tests load it through the `vm` module
// (see `tests/auth-stale.test.ts`) and read the function off the same
// global, so there is exactly one source of truth for the mapping.
//
// IMPORTANT: keep this file dependency-free and side-effect-only.
// Anything heavier belongs in `app.js`.

(function () {
  function computeRefreshIndicator(healthData) {
    var poll = (healthData && healthData.authPoll) || {};
    if (poll.stale) {
      var age = poll.lastSuccessAgeMs != null
        ? Math.round(poll.lastSuccessAgeMs / 1000) + 's'
        : 'never';
      var err = poll.lastError ? ' — ' + String(poll.lastError).slice(0, 60) : '';
      return { text: '⚠ auth-poll stale (' + age + ')' + err, className: 'stale' };
    }
    return { text: '● auto-refresh 5s', className: '' };
  }

  // Browser path — `window` is defined.
  if (typeof window !== 'undefined') {
    window.computeRefreshIndicator = computeRefreshIndicator;
  }
  // Test path — vm.createContext exposes `globalThis` only.
  if (typeof globalThis !== 'undefined') {
    globalThis.computeRefreshIndicator = computeRefreshIndicator;
  }
})();
