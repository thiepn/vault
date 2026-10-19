# Agent instructions — functional UI copy

Applies to every screen, component, dialog, card, form, and responsive layout in this repository.

## Zero-filler rule
Every **visible UI string** must have a clear functional purpose: identify a control or section; present real content, data, or state; give an instruction necessary to complete a task; or communicate feedback, errors, consent, safety, or accessibility information.

Do **not** add or retain:
- Decorative, motivational, congratulatory, or marketing-style microcopy.
- Generic subtitles, taglines, helper paragraphs, or captions that merely restate a heading.
- Commentary explaining obvious buttons, cards, navigation, or self-evident actions.
- Repeated status descriptions or labels that convey no new information.
- Tiny faint captions inserted merely to fill visual space.

Before adding or retaining any user-visible copy, ask: **Would removing this make the interface less understandable, actionable, accurate, or accessible?** If not, omit it.

## Preserve substance
Do not remove substantive educational lessons, domain explanations, real records or metadata, meaningful onboarding, necessary form help, status and error messages, privacy/legal notices, or screen-reader labels. Prefer context-specific help when genuinely needed. This policy concerns rendered UI filler, not useful source-code comments.

## Presentation and implementation
- Prefer clear labels, strong information hierarchy, and whitespace over explanatory clutter.
- Supporting text must be legible; normally use at least 14px rather than tiny low-contrast captions.
- When cleaning existing screens, remove pointless rendered content **and** its redundant layout; do not merely hide it with CSS or replace it with different filler.
- Respect existing behavior, IDs, records, rights, accessibility, and feature boundaries.
- Apply this policy as part of feature work; do not create repetitive audit-only phases.
- Review affected desktop and mobile views, and adjust tests only for intentional copy changes.

**Acceptance:** Any new visible text has an identifiable user-facing function; no ornamental UI commentary is introduced.
