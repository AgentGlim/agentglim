# Lifecycle matrix

Terms: **close UI** (window or tab closes), **exit app** (tray quits; daemon keeps running unless "stop daemon on
quit" is set), **stop server** (`agentglimd stop` or service stop), **shutdown** (OS), **logout** (user session ends).

| # | Scenario | Daemon | Tasks | Clients | Test (01 unless noted) |
|---|---|---|---|---|---|
| 1 | Window / tab close | keeps running | untouched | other clients unaffected | **planned (04, browser client)**: no browser client exists yet, so there is nothing to close. This round measured only that ingestion is independent of any client: `tests/ingest_recovery.rs::b_restart_after_commit_has_no_duplicates` crashes and restarts the daemon while no client is connected and no event is lost. |
| 2 | Logout | user service stops (SIGTERM / launchd / task end) | running tasks get cancel + 10 s grace; state `interrupted` | WS closes with code 1001 | `tests/lifecycle.rs`: send SIGTERM; state rows say `interrupted`, exit 0. Measured again with live polling in `tests/ingest_recovery.rs`: `cargo test --test ingest_recovery b_restart_after_commit -- --nocapture` measured `SIGTERM exit 25 ms` with exit status 0. |
| 3 | Reboot | starts at login via service | `interrupted` tasks shown, never auto-rerun | reconnect with backoff | `tests/lifecycle.rs`: restart daemon; no task runs twice |
| 4 | OS kills UI | as 1 | as 1 | as 1 | as 1 (planned, 04) |
| 5 | Daemon crash | service manager restarts (Restart=on-failure, KeepAlive, task restart-on-failure) | lock file with pid; stale lock reclaimed after pid check | clients show "daemon down" then reconnect | `tests/lifecycle.rs`: `kill -9`; restart within 5 s; lock reclaimed. Extended for ingestion by `tests/ingest_recovery.rs::b_restart_after_commit_has_no_duplicates`: SIGKILL right after events are committed, restart on the same data dir, **no duplicate and no lost event**, `seq` consecutive, `source_offsets` restored; measured `crash-to-healthy 52 ms`, 12 events before and after the crash. |
| 6 | Sleep | timers pause | no catch-up storm: one poll after wake | WS may drop | `tests/poll_loop.rs::d_ten_minute_jump_polls_once`: simulates a 10-minute clock jump and asserts the poll closure runs exactly once (not ~300) with `MissedTickBehavior::Skip`. |
| 7 | Wake | resumes, re-detects network | as 6 | reconnect + `since` replay | planned (03, WS `since` replay): reconnect test with seq gap |
| 8 | Network drop | keeps running on 127.0.0.1 | local unaffected | PWA shows cached shell + "offline" | planned (04, tailnet bind): drop the tailnet bind; localhost still serves |
| 9 | Android / iPhone disconnect | stale WS detected by ping every 20 s, closed after 2 misses | none | device row shows last seen | planned (03/04, WS ping): WS ping timeout test |
| 10 | App update | old daemon drains (stops accepting tasks), new binary migrates DB in a transaction, restarts | none lost | UI checks `api_version`; mismatch banner | `tests/migrations.rs`: migration up on a copy of an old DB; compat check in 05. Extended by `tests/migrations.rs::upgrade_from_pre_occurrence_database_keeps_data`: an existing database from before migration 0004 upgrades in place, keeps its events/cursors (unknown occurrence time stays 0) and accepts new offset-less ingestion. |

Rows 1, 2, 5 and 10 carry the evidence produced this round; rows 3, 4 and 6-9 are unchanged.

## Also in 01
- Config is validated at load: a bad config refuses to start with a clear error, never half-starts.
- DB migrations are numbered and transactional.
- Structured JSON-lines logs, rotated at 10 MB x 5 files, redacted at write time (see *Privacy* below).
- Graceful shutdown on SIGINT/SIGTERM/Ctrl-C (Windows `CTRL_CLOSE_EVENT`).
- Duplicate-task lock: a task id runs at most once; a second POST returns 409.

## Ingestion recovery

One committed batch is exactly the input that was consumed; a failed commit consumes nothing; re-reading the same
source time never silently drops a genuine repeat. Evidence: `cargo test --test ingest_recovery` (10 tests),
`--test identity_recovery` (7 tests: checkpoint-only restart, failed-first-batch retry, commit-before-publish
restart, partition replay, offset-less A -> B -> A through a restart, removal/reappearance, store transaction
atomicity), `--test poll_loop`, `--test retention`, `--test migrations`.

**Observation time vs occurrence time.** `events.ts` is always the observation time (`now_ms()`, when the daemon read
the record) and never the source's own time. The source time goes to `events.occurred_ms` (migration 0004), `0` when
the source carries none. The key order in an item's `data`, first present *and* parseable wins:
`occurred_ms` (number, epoch ms), `ts` (every JSONL adapter writes it: ISO-8601 from Claude Code/Codex/Pi/Agy, epoch
ms from OpenCode), `at` (generic alias), `started` (session/run announcements), then OpenCode's numeric time object
(`time.created`, `time.completed`, `time.start`, `time.end`). A number below 1e11 is read as epoch seconds, otherwise
as epoch milliseconds; an ISO-8601 string without a zone is read as UTC. Historical records keep their historical
`occurred_ms`: a fixture record from 2026-10-31 ingested today stores 1793457000000 while its `ts` is today.

**Dedup identity.** Sources with file offsets need no identity: the offset already identifies the record, so
`events.occurrence` is `NULL`. Sources without offsets (plans-harness, fake) get
`occurrence = sha256(source | session | kind | sha256(data) | occurred_ms | n)`, where `n` counts earlier items of
the same batch with the same first five components. Consequences: A -> B -> A keeps all three observations (the
second A differs by `occurred_ms`, or by `n` when the time matches); two identical usage records of one message
inside one batch are both kept (`n` = 0 and 1); re-reading the same batch produces the same identities and inserts
nothing. The 0003 `dedup` column is frozen at `NULL` for new rows; the `occurrence` partial unique index enforces
dedup only where the identity exists.

**Producer identity (migration 0006).** That content-derived identity cannot survive a repartition or a parser
reset, so an adapter may now supply the stable identity of every emitted item: `Source::identities()` returns one
`RecordKey` per item of the last poll, either
`Offset { path, generation, position, item }` (logical file generation, the record's start position inside it, and the
index of this item among the items that record emitted) or `Revision { namespace, revision, item }` (durable
semantic revision of a snapshot producer). The key is stored in `events.producer` under the partial unique index
`events_producer`, so identical replays insert nothing even when the batch boundary differs, while a genuine
A -> B -> A keeps three rows with identical payload and time. Neither form is a content hash nor a per-batch index.
Adapters that do not implement `identities()` keep exactly the policy above (per item, in this order: producer key,
then the offset-less `occurrence` key, then offset-only dedup), so an adapter can adopt the contract without a core
change. `tests/identity_recovery.rs` proves the offset, revision, partition-replay and restart cases against a
scripted source driving the real poller.

**Whole-checkpoint commit.** One transaction now covers events, `source_offsets`, `source_file_state`,
`source_revisions` (the adapter's source-level revision map, e.g. snapshot rounds) and `source_removed`
(tombstones). A batch with no events still commits when only the checkpoint moved - a parser generation, a
fingerprint, a revision counter or a tombstone - and that checkpoint is restored before the first poll, so the
progress survives a restart. A failed transaction commits none of it and the pending batch (items, identities,
checkpoint, tombstones) is retried unchanged; `tests/identity_recovery.rs::b_failed_first_batch_retries_exactly_once`
injects the failure with a trigger instead of relying on lock timing.

**Removal and reappearance.** A path an adapter stops reporting (allowed only after a completed discovery sweep)
is tombstoned in `source_removed` with its last generation in the same transaction that deletes its file state and
cursor, and the tombstone is handed back to the adapter through `Source::restore_removed` before its first poll. A
reappearing path clears its tombstone and starts from whatever the adapter re-reads, so no stale offset is
inherited; `tests/identity_recovery.rs::f_removal_then_reappearance_is_clean` checks the surviving rows, the
tombstone delivery and the new generation's identity.

**Commit / rollback.** `Store::append_batch_at` writes events and `source_offsets` rows in one transaction, and `seq`
is consecutive for the rows actually inserted. The poller no longer consumes input before the commit: it advances
the adapter cursor and its in-memory offsets only after `append_batch` returns. On failure it logs the source id and
item count and calls `restore_offsets(last committed)`, keeping the cursor at the last committed value, so the next
pass retries exactly those items once. Measured: with an exclusive write transaction held for 6.2 s on the daemon's
`state.db` (busy timeout 5 s, so the append really fails), no event and no offset advance during the failure, and the
retried record lands exactly once (offset advances by exactly the appended line's bytes).

**Restart.** Offsets are restored before the first poll, so a restart re-reads only newer bytes: SIGKILL right after
a commit and restart on the same data dir yields the same events, the same `occurred_ms`, consecutive `seq` and the
same `source_offsets` rows. Appending one line after a restart needs no new session/model header: the items land with
their session attribution.

**Source toggle.** `config.json` `sources` is applied when the registry is built at startup, so disabling a source
takes effect on the next start, not live. A disabled source produces no events and no `/status` entry, and its stored
offsets are left alone: they are never replayed into another source. The API's `restart_required_for` list is
api-owned and does not mention `sources` yet; that is a known gap recorded in
`_build/v2-r1/workers/ingest-recovery/REPORT.md`.

**v2-r2 gaps (not fixed here).** Adapter parser state (session id, fallback model, "already announced" flag, file
generation/fingerprint) is kept by the adapters themselves now and persisted through `SourceCheckpoint`; what is
still open is that the real adapters do not yet supply producer identities (`Source::identities()` defaults to
empty) and the plans-harness/OpenCode snapshot revisions are adapter-owned work outside this file's evidence. Until
they do, an offset-bearing adapter still depends on its committed offset for dedup, which is correct only while the
adapter never re-reads bytes it already committed (a replay from offset 0 is deduplicated only by the identity the
adapter supplies). Plan 08 event mapping, `/status` counts, projections and `/costs` are also v2-r2 scope and
unchanged.

Status after v1-r1: rows 2, 3, 5 and 10 have passing tests in `crates/agentglimd/tests/lifecycle.rs` and
`tests/migrations.rs`; the rows marked planned get their tests in the sub-item named.

## Privacy: redaction before storage and broadcast

One redaction policy, `logging::redact` (text) and `logging::redact_value` / `logging::redact_json` (payloads), is
applied at the daemon's output boundary rather than only to log lines. It is deterministic, does not allocate a
second copy of the record set, is idempotent (a second pass is a no-op) and never drops a record: the sensitive run is
replaced with `[redacted]` (or `[redacted-email]`) and the rest of the value is kept byte-for-byte.

Where it runs:

| Path | Where | What becomes durable / visible |
|---|---|---|
| Source ingestion | `Store::commit_batch`, before the SQLite transaction | each item's `data` and `session` are redacted; the rows *and* the returned `Event`s (which `Bus::commit` then broadcasts) carry the same redacted payload |
| Daemon events | `Bus::publish` (and `Store::insert_event` as defence in depth) | the published `Event` is redacted before insert and before fanout, so the returned value, the row and the WS/broadcast copy agree |
| Audit trail | `Store::audit` | `actor`, `action` and `detail` are redacted before the insert |
| Logs | `RotatingWriter` (behind `logging::init`) | every JSON line, including rotated files |

Rules, in order:

1. **Home paths.** The process home directory (`$HOME`, `%USERPROFILE%`) and the conventional Linux and macOS home
   prefixes (a user segment directly under the home root) collapse to `~`, so a stored path keeps its structure
   (`~/project/.env`) but not the user name. The *segment* is replaced, not the whole path.
2. **Headers and key material.** A scheme plus value for `Bearer`, `bearer`, `Basic` and `basic`, and the API-key
   prefixes of OpenAI-style, GitHub and Slack keys (the exact literal list lives in `src/logging.rs`) keep the
   scheme or prefix and replace the value.
3. **Credential-named fields.** In JSON, a string (or array/object of strings) under a credential key is replaced
   whole, whatever its shape. Exact keys: `token`, `secret`, `password`, `passwd`, `authorization`, `cookie`,
   `set-cookie`, `api_key`, `apikey`, `access_token`, `refresh_token`, `install_token`, `private_key`,
   `credentials`; plus the `_token`, `-token`, `_secret`, `-secret`, `_password`, `_passwd`, `_api_key`,
   `_private_key` suffixes. Numbers and other non-string scalars are left alone, so usage counters such as
   `input_tokens` are never destroyed.
4. **Credential context in free text.** A run of at least 20 token characters that mixes letters and digits and
   follows a credential word (`token`, `secret`, `password`, `api key`, `authorization`, `credential`, `private key`)
   within a short distance is replaced. This catches an opaque install-token-length string quoted in an audit detail
   or a log message.
5. **Addresses.** An email-shaped word (a plain local part, an at sign, a hostname domain) becomes
   `[redacted-email]`. Words carrying a URL or scp-style separator are left alone, so links and git remotes keep their
   shape.

Consequences that are deliberate:

- **Structure and identifiers are untouched.** `seq`, `kind`, `source`, `ts`, `occurred_ms`, the dedup/producer
  identity, offsets, checkpoints and tombstones are never redacted. Only payload strings can change.
- **Dedup and retry are unchanged.** The occurrence identity is computed from the *redacted* payload, so a replayed
  batch still deduplicates and a rolled-back transaction retried with the same input lands exactly once with the same
  values (`tests/privacy.rs::rollback_then_retry_keeps_redaction_and_atomicity`).
- **A 64-hex value in free text is a judgement call.** Next to a credential word it is redacted; on its own it is
  kept, because it is indistinguishable from a legitimate `sha256` fingerprint or content hash that snapshots store.
- **Operational state is not event content.** `source_file_state` and `source_offsets` keep the file paths, session
  and model an adapter needs to resume tailing; they are local state, not the event/audit trail, and are not redacted.
- **Redaction is a policy, not a sandbox.** A secret that is neither written in one of the shapes above nor under a
  credential key name survives, and adapters still hold the raw text in memory before the store boundary. The daemon
  does not read credentials, sign in to anything, or send transcript payloads anywhere.

Evidence: `tests/privacy.rs` plants five distinct canaries (an install-token-shaped value, a `Bearer` header, an email
address, an API-key-shaped string and an absolute test home path) in a fake source's batch, drives it through the real
poller, bus and store, and asserts each canary is absent from `events.data`, `events.session`, the audit rows, the
broadcast payload and the JSON log files, while the non-secret fields of the same items survive byte-for-byte; the
canaries are asserted present in the batch input first, so the check cannot pass vacuously. `logging.rs` unit tests
cover the rules and their idempotency, and `tests/scrub.rs` scans `src/`, `tests/`, `web/`, `fixtures/` and `docs/` for
emails, home paths and token shapes, with a negative self-test that plants each shape in a temporary copy.
