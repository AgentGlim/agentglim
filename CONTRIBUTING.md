# Contributing

## Branches, pull requests and releases

- `main` is the production branch and is protected: no direct pushes.
- Work on a branch (`fix/...`, `feat/...`), push it and open a pull request into `main`.
- CI (`.github/workflows/ci.yml`) must pass before merge: the privacy and leak scan, then the unit tests on Linux, macOS
  and Windows.
- Releases are annotated tags on `main`: `git tag -a vX.Y.Z -m "AgentGlim vX.Y.Z" && git push origin vX.Y.Z`.

## Privacy check before every commit

Enable the repo's hooks once per clone:

```sh
git config core.hooksPath .githooks
```

`.githooks/pre-commit` runs `node dev/privacy-check.mjs` and then `dev/leak-scan.mjs` on exactly the staged files,
matching key values from your local `.env` without printing them. A finding stops the commit. CI runs the same checks
on every pull request, so skipping the hook with `--no-verify` only moves the failure to the pull request.

## Checks and development

Run `npm test` and `npm run privacy-check` before committing. The privacy checker scans tracked and publishable
untracked files for credentials, private names, home-folder paths and copied private goals. Set private names in
`~/.config/agentglim/private-names.txt`; never commit that file. `node dev/leak-scan.mjs FOLDER` scans an export.
These are contributor checks, not user onboarding steps.

Use `AGENTGLIM_DEV=1 node app/server.mjs 18992` for development. Use a scratch HOME, an empty `AGENTGLIM_ENV_FILE`
and isolated data when testing a clean install. Dev mode disables pricing/reset jobs, usage polling and process actions.
Back up existing files before edits. Keep archived copies and private screenshots outside release staging.

The desktop staging script includes generic add-ons and bundled project skills but never machine skills, profiles,
.env files, logs or runtime data. Node can be shipped as a platform-specific licensed sidecar in a future installer;
currently it must be installed separately. Chromium, Python, harness CLIs, local models and Tailscale stay optional.
