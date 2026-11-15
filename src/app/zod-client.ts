import { config } from "zod";

// Without eval in the CSP, zod's probe for its JIT (`Function("")`) fails silently but is still reported as a
// CSP violation (Lighthouse Best Practices). The client parses small payloads: the JIT brings nothing.
// Imported first by every client module that parses with zod, directly or through the AI SDK.
config({ jitless: true });
