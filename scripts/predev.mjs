// Runs before `npm run dev`. Leftover PRODUCTION build output in .next (from `npm run build`,
// which the test pipeline runs) makes the Next.js 16 dev server's hot reload loop the page.
// Remove it so the dev server always starts clean.
import { existsSync, rmSync } from "node:fs";

if (existsSync(".next/BUILD_ID")) {
  rmSync(".next", { recursive: true, force: true });
  console.log("predev: removed stale production build output from .next");
}
