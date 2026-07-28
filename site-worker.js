// Canonical-host shim + the demo's analyst endpoint; everything else falls through to assets.
import { handleChat } from "./worker/chat.js";
import handleDemoGen from "./worker/demo-gen.js";

// The demo generator's Durable Object has to be exported from the Worker's entry module for
// the DEMOGEN_DO binding to resolve. It is otherwise only ever reached through demo-gen.js.
export { DemoGenDO } from "./worker/do.js";

export default {
  fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.hostname === "www.alloylogger.com") {
      url.hostname = "alloylogger.com";
      return Response.redirect(url.toString(), 301);
    }
    if (url.pathname === "/demo/api/chat") {
      return handleChat(request, env);
    }
    // Generated demos: the API surface, plus the one file a g-<slug> bundle serves. Neither
    // path ever exists as a static asset, so a miss inside them is a real 404.
    if (url.pathname.startsWith("/api/demo-gen/") || url.pathname.startsWith("/demo/js/robots/g-")) {
      return handleDemoGen(request, env, ctx, url);
    }
    return env.ASSETS.fetch(request);
  },
};
