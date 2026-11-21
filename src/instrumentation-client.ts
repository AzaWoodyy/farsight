import { initBotId } from "botid/client/core";

initBotId({
  protect: [
    { path: "/api/ask", method: "POST" },
    { path: "/api/feedback", method: "POST" },
  ],
});
