# flowfig

Turns existing web pages and AI-agent-generated code into real, editable Figma nodes — through one shared file format and one writer that's ever allowed to touch the Figma API.

## Documentation

- **[Documentation/MISSION.md](Documentation/MISSION.md)** — the north star: what flowfig is, its non-negotiables, and what's explicitly out of scope. Read this first.
- **[Documentation/architecture-plan.md](Documentation/architecture-plan.md)** — the full pipeline, file kinds, tagging convention, publish matrix, and resolved product decisions.
- **[Documentation/PROJECT-TRACKING.md](Documentation/PROJECT-TRACKING.md)** — phase status, requirements checklists, blocking gates, and the risk register. Check here for what's built vs. planned.

## Packages

| Package | Phase | Ships via | Docs |
|---|---|---|---|
| [`core`](packages/core) | P0 | private, never published | [ARCHITECTURE.md](packages/core/ARCHITECTURE.md) |
| [`figma-plugin`](packages/figma-plugin) | P1 | Figma Community | [ARCHITECTURE.md](packages/figma-plugin/ARCHITECTURE.md) |
| [`agent-kit`](packages/agent-kit) | P2 | npm | [ARCHITECTURE.md](packages/agent-kit/ARCHITECTURE.md) |
| [`extension`](packages/extension) | P3 | Chrome Web Store | [ARCHITECTURE.md](packages/extension/ARCHITECTURE.md) |

No implementation exists yet — every package above is currently a workspace stub plus an architecture doc. See `Documentation/PROJECT-TRACKING.md` for current status.
