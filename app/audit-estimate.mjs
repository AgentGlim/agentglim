// audit-estimate.mjs: the auditor's spec-completion % from an AUDIT.md or VERIFY.md.
// Shared by the Observatory (server.mjs) and _run/bin/audit-bump.mjs; import it, never copy it.

// The auditor's overall spec-completion estimate. The first "NN%" in an audit is often a phase figure
// ("P1 ≈ 100%") or an unrelated number ("max(1%,$1)"), so look for the estimate sentence itself.
// Checked against every AUDIT.md of plans 01-38 (Oct 18).
export function auditEstimate(md) {
  // the estimate usually sits in a "Progress" section; search that first, then the whole audit
  const prog = md.split(/^(?=#{1,4} )/m).filter((s) => /^#{1,4} .*(progress|completion|estimate)/im.test(s.split('\n')[0]));
  for (const scope of [...prog, md]) {
    // sentences: wrapped lines joined, split at blank lines, list items, table cells and full stops
    const parts = scope.replace(/\*\*|`/g, '').split(/\n\s*\n|\n(?=\s*(?:[-*]|\d+\.|\|) )|\|/)
      .flatMap((b) => b.replace(/\s*\n\s*/g, ' ').split(/(?<=[.;])\s+(?=[A-Z*])/));
    const pctAfter = (s, i) => {
      for (const m of s.slice(i).matchAll(/(\d{1,3}(?:\.\d+)?) ?%/g)) {
        // skip a single phase's figure ("P2 ≈ 90%"), keep ranges ("P1–P3 ≈ 97 %")
        if (/(?<![-–]\s?)\b[PVB]\d\b(?:\s*(?:is|at|≈|~|about|approximately|:|=))+\s*$/i.test(s.slice(0, i + m.index))) continue;
        return Number(m[1]);
      }
      return null;
    };
    // "Estimated ... completion: 80%", "Overall: about 78%", "Whole spec ≈ 90%", "Progress: ~30 %"
    for (const s of parts) {
      if (!/complet|spec|implement|progress|done|deliver|PLAN|product|overall|whole/i.test(s)) continue;
      for (const k of s.matchAll(/\b(estimat\w*|overall|whole spec\w*|spec completion|progress)\b/gi)) {
        // "previous estimate 62%" is history, not the current figure
        if (/\b(previous|prior|earlier|last|old)\s+$/i.test(s.slice(0, k.index))) continue;
        const p = pctAfter(s.slice(0, k.index + 90), k.index);
        if (p != null && p <= 100) return { pct: Math.round(p), text: s.trim().slice(0, 300) };
      }
    }
    // "About 63% of the BUILD-V2 specification is delivered", "about 85% implemented"
    for (const s of parts) {
      const m = s.match(/(\d{1,3}) ?%\s+(?:of\s+(?:the\s+)?[\w\s–-]{0,40}?\b(?:spec\w*|PLAN|implementation)\b|(?:is\s+)?(?:implemented|complete|done)\b)/i);
      if (m && pctAfter(s, m.index) === Number(m[1])) return { pct: Number(m[1]), text: s.trim().slice(0, 300) };
    }
  }
  return null;
}

// every round folder (vN-rK) of a plan's _build, oldest first
export function roundDirs(names) {
  return names.filter((n) => /^v\d+-r\d$/.test(n)).sort((x, y) => (+x.slice(1).split('-r')[0] - +y.slice(1).split('-r')[0]) || x.localeCompare(y));
}
