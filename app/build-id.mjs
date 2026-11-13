// build-id.mjs: the id the dashboard compares to notice that new page code is deployed.
// It is a short hash of the files the browser loads (index.html and its scripts and styles), built from their
// size and mtime. A deploy on disk changes it without a restart; a restart alone does not. Read at most once
// every few seconds, so the 5 s snapshot loop costs a handful of stat calls, never a file read.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// what the dashboard actually loads (index.html references the rest); a new or renamed asset belongs here
export const PAGE_FILES = [
  'index.html', 'theme.css', 'theme.js', 'update-notice.css', 'update-notice.js',
  'walkthrough.js', 'walkthrough.css', 'shortcuts.js', 'portable-ui.js', 'model-icons.js', 'plan-icons.js', 'app-links.js',
];

// makeBuildId(dir) -> () => id. The returned reader caches for cacheMs (default 3 s) and never throws:
// a missing asset is part of the id, so deleting one is a change too.
export function makeBuildId(dir, { files = PAGE_FILES, cacheMs = 3000, now = Date.now } = {}) {
  let at = -Infinity, id = null;
  return () => {
    const t = now();
    if (id && t - at < cacheMs) return id;
    const h = crypto.createHash('sha1');
    for (const f of files) {
      try {
        const st = fs.statSync(path.join(dir, f));
        h.update(`${f}:${st.size}:${Math.round(st.mtimeMs)};`);
      } catch {
        h.update(`${f}:missing;`);
      }
    }
    id = h.digest('hex').slice(0, 12);
    at = t;
    return id;
  };
}
