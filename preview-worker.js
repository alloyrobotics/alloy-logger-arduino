// Review-preview worker: serves the working-tree demo assets on workers.dev while
// production alloylogger.com stays on the deployed alloylogger-site version.
// The site worker's API surface is not duplicated here; the endpoints the demo
// actually calls are proxied to production so the analyst chat and signup capture
// behave exactly as they would live. The demo-gen surface is deliberately absent.
const PROD = "https://alloylogger.com";

export default {
  fetch(request, env) {
    const url = new URL(request.url);
    if (
      url.pathname === "/demo/api/chat" ||
      url.pathname === "/api/signup-lead"
    ) {
      return fetch(PROD + url.pathname + url.search, request);
    }
    return env.ASSETS.fetch(request);
  },
};
