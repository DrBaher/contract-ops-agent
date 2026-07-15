import { createRequire } from "node:module";

// Single source of truth for the app version — everything that reports a
// version (MCP client handshakes, banners) reads it from package.json so a
// release bump can't leave stale strings behind.
export const VERSION = createRequire(import.meta.url)("../package.json").version;
