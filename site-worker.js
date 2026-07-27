// Canonical-host shim + the demo's analyst endpoint; everything else falls through to assets.
import { handleChat } from "./worker/chat.js";

export default {
  fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname === "www.alloylogger.com") {
      url.hostname = "alloylogger.com";
      return Response.redirect(url.toString(), 301);
    }
    if (url.pathname === "/demo/api/chat") {
      return handleChat(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};
