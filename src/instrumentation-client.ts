import { initBotId } from "botid/client/core";

// BotID (Basic) challenges the browser before the chat calls /api/ask or
// /api/feedback. In development (`bun run dev`) it does nothing.
initBotId({
  protect: [
    { path: "/api/ask", method: "POST" },
    { path: "/api/feedback", method: "POST" },
  ],
});
