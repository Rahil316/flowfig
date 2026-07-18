# flowfig — Mission

This is the one page every future decision gets checked against. If a proposal — a new phase, a new package, a "wouldn't it be nice if" — doesn't fit on this page, it doesn't belong in flowfig v1. Take it to `Documentation/PROJECT-TRACKING.md`'s backlog instead of building it now.

## What flowfig is

flowfig turns two kinds of source — an existing live web page, or AI-agent-generated code — into real, editable Figma nodes, through one shared JSON file format and one writer that's allowed to touch the Figma API.

## The one idea everything else follows from

**Two producers, one bridge, one writer.**

- Producer A (`extension`) captures pages that already exist.
- Producer B (`agent-kit`) captures code an agent just generated.
- Both produce files, never a live connection.
- One module (`figma-plugin`'s Node Writer) is the only thing ever allowed to call `figma.*`.

Every package's job is to feed that one writer well — not to grow a second way of writing to Figma, and not to blur which producer is responsible for which file kind.

## Non-negotiables

These are the constraints a future conversation is not free to relitigate casually. Changing one of these is a big deal, not a routine call — flag it explicitly if it comes up.

1. **Only `figma-plugin`'s Node Writer calls `figma.*`.** `core`, `extension`, and `agent-kit` never touch the Plugin API, directly or via a dependency.
2. **File hand-offs only, never a live connection.** Nothing in this system talks to another part of it over a socket, a shared server, or a live RPC. Producer → file → Figma plugin, always.
3. **`core` has zero runtime dependency on `figma`, `chrome.*`, or Node built-ins.** It is the one library all three very different runtimes (Figma plugin sandbox, Node CLI, MV3 extension) can each compile with their own bundler.
4. **`formatVersion` mismatches hard-reject. No migration shims, ever.** A file made by a newer producer than the installed plugin supports fails loudly and specifically — it never gets a best-effort parse.
5. **No hosted backend, sync service, or account system anywhere in this repo.** Snippets, settings, symbol tables — everything that needs to persist lives in `clientStorage` or on disk as a file. If cross-machine sync becomes a real ask later, that's a new decision to make deliberately, not a default to slide into.
6. **flowfig and flowkit share a brand family and nothing else.** No functional relationship, no shared code, no implied dependency between the two projects. Do not let a future "wouldn't it be convenient" merge them.
7. **One fixed viewport, one DOM state, per generation.** No hover/focus/transition capture, no multi-breakpoint capture, in v1. This is a stated boundary, not a gap someone forgot to fill in.

## Explicitly out of scope for v1

Naming these so nobody has to rediscover that they were already considered and cut:

- Multi-viewport or interactive-state (hover/focus/transition) capture.
- Closed shadow roots and cross-origin iframes beyond an opaque bounding box — real, structural gaps, not bugs to chase.
- ML/visual-similarity-based structural component matching (v1 is exact-signature clustering only; see `packages/extension/ARCHITECTURE.md`).
- Cross-machine snippet sync or any account system.
- Best-effort `formatVersion` migration.
- A second `figma.*`-calling surface anywhere outside `figma-plugin`.

## What "done" looks like for v1

A user can either (a) point the Chrome extension at a real page, or (b) run `agent-kit generate` against agent-written code, and in both cases end up with a file that the Figma plugin imports into real, correctly-laid-out nodes — using existing design-system components/tokens where a match exists, and clearly flagging everything it couldn't confidently resolve. That loop working end-to-end, for the phased scope in `Documentation/PROJECT-TRACKING.md`, is what "shipped" means here — not full design-system parity, not multi-viewport fidelity, not a plugin store featured badge.

## Where the rest of the detail lives

This page is deliberately short. Everything else has its own home:

- **`Documentation/architecture-plan.md`** — the full pipeline, file kinds, tagging convention, publish matrix, and the resolved product decisions.
- **`Documentation/PROJECT-TRACKING.md`** — phase status, requirements checklists, cross-package blocking gates, and the consolidated risk register.
- **`packages/*/ARCHITECTURE.md`** — one per package (`core`, `figma-plugin`, `extension`, `agent-kit`), each a concrete, research-backed implementation plan for that package specifically.

If something you're about to do doesn't trace back to a line on this page, stop and check `PROJECT-TRACKING.md` before assuming it's in scope.

---

*flowfig · mission · 2026-07-18*
