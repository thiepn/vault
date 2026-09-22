# Phase 13 acceptance — Obsidian Import, Migration & Interoperability

## Result

**ACCEPTED — external Obsidian migration and bidirectional Canvas interoperability are certified.**

## Acceptance criteria

- standard STORE ZIP accepted
- standard DEFLATE ZIP accepted
- unsafe ZIP paths rejected
- CRC mismatch rejected
- encrypted/multi-disk/ZIP64 unsupported cases fail explicitly
- browser folder import supported
- import creates a separate new Vault
- existing Vaults are never merged/overwritten
- migration plan is visible before commit
- `.obsidian` configuration is reported but not executed/imported as Vault configuration
- detected community plugins are surfaced
- portable-name repair is deterministic
- case/name collisions do not overwrite content
- Wiki links rewrite after path repair
- standard Markdown links rewrite after path repair
- safe relative link paths resolve
- ambiguous references are not guessed
- Markdown/frontmatter source is preserved
- attachment bytes are preserved
- invalid `.canvas` is preserved as an attachment
- valid JSON Canvas converts to canonical `vault-canvas`
- supported text/note/media/group/edge Canvas data migrates
- unsupported Canvas constructs produce warnings rather than silent loss
- imported task lines receive stable Vault task identities
- local import commit is atomic
- A2 canonical mirror is rebuilt after commit
- A2 mirror failure is recoverable without losing imported canonical files
- Obsidian-oriented export preserves Markdown/attachments
- valid Vault Canvas blocks produce `.canvas` companions
- Vault-only query/board source is not silently rewritten
- migration planner stays inside large-vault performance budget
- desktop migration workflow passes
- mobile migration workflow passes
- all earlier browser regressions pass
- production build passes

## Certification

Authoritative CI: **35714179858 / #255**

- **97 core tests passed**
- **5 performance gates passed**
- **29 applicable Chromium scenarios passed**
- **29 opposite-device scenarios skipped by design**
- **0 failures**

10k migration plan: **247.8 ms** for 10,000 source files, 16,000 link rewrites and 200 Canvas conversions.

## Deliberate non-goals

Phase 13 does not run the Obsidian plugin runtime, import Obsidian settings as Vault application settings, maintain a live filesystem mount, merge an imported folder into an existing Vault, promise semantic conversion for arbitrary community-plugin data, implement ZIP64/streaming migration for multi-gigabyte vaults, or convert Vault query/board definitions into invented Obsidian equivalents.

The migration report exists specifically so unsupported semantics are visible rather than silently guessed.