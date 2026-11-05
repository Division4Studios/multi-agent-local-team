# Architecture explorer usability review

This is an **AI heuristic design and product review**, not a human usability test. It covers the architecture explorer, native sidebar, standards-gap explanations, and scan feedback. The visual reference is [Archify's examples](https://github.com/tt-a1i/archify/tree/main/examples); the implementation must preserve MALT's source verification and workspace boundaries.

## Product requirements

The interface should answer three questions in order: **What am I looking at? What does this connection mean? Where can I verify it?**

| Area | Required behavior |
| --- | --- |
| Orientation | Keep the project, branch, diagram type, and selected item identifiable. Group project operations separately from everyday exploration. |
| Canvas | Give the diagram most of the space. Use restrained edges, readable labels, subtle group colors, and a distinct selection outline. Colors must have matching legend labels. |
| Inspector | Show the full item name, a short explanation, relationship direction, and source action together. Wrap paths. Stack below the canvas in a narrow editor. |
| Sidebar | Use native theme-aware icons. Show disclosure chevrons only when content exists. Label incoming, outgoing, and self relationships accurately. |
| Playback | Animate only on request. Highlight the exact active relationship and its endpoints; state the step number and message. Sequence views follow authored order, including returns. Never jump from a terminal selection to an unrelated route. |
| Playback controls | Provide pause, next step, reset, and a clear finished state. Stop or deliberately rebase playback when the view changes. Reduced motion preserves step information without animation. |
| Gap explanation | Lead with a plain-language summary. Separate observations, why they matter, and the decision. Use representative examples instead of directory inventories. Hover and full details should agree. |
| References | Open verified workspace references directly. Do not invent a link for an ambiguous or missing path. Preserve all relevant references in the detailed view. |
| Scan status | Identify the active task and completed stages, including failure or skipped analysis. A stage percentage is not elapsed-time progress; do not imply that model calls provide a measurable remaining duration. |
| Empty states | Explain why a view has no evidence or playable relationships. Disable unavailable actions and give one relevant next step. |

## Manual acceptance tasks

These tasks remain checks to perform, not claims that human testing passed.

1. **First use:** Open a project and identify its branch, selected diagram, and next useful action without documentation.
2. **Inspect and verify:** Select a component, explain an incoming and outgoing relationship, and open the supporting declaration. Repeat using only the keyboard.
3. **Follow a flow:** Play a sequence with a return message. Pause, advance one step, reset, and finish. Check that the highlighted arrow matches the written message and that focus remains usable after redraw.
4. **Edge cases:** Select a terminal item, a self-loop, a branch, an empty graph, and a search with no results. Confirm that no control silently plays a different route or does nothing without explanation.
5. **Read a gap:** Explain the issue and required decision after reading the summary. Open each representative reference. Compare the hover with full details; neither should require manually finding a named file.
6. **Wait for a scan:** Observe a slow architecture call and a failed or skipped gaps stage. Identify what is active and what results remain usable without treating the progress bar as a time estimate.
7. **Theme and size:** Repeat the main tasks in light, dark, high contrast, reduced motion, a roughly 320px sidebar, and a roughly 700px split editor. Check long paths, visible focus, readable text, and scroll access to controls.

For an actual human usability session, ask a developer unfamiliar with the project to perform these tasks without coaching. Record where they hesitate, misread direction, lose their place, or cannot find evidence. Resolve those observations before treating the design as validated for users.

## Reference coverage

All 23 HTML entries in the supplied Archify examples directory were inspected as source (including the two redirect pages). These are reference studies, not claims of successful browser interaction or screenshot comparison. Chrome access was unavailable during this implementation.

| Examples | Design patterns considered |
| --- | --- |
| `archify-repo.html`, `archify-repo-grid.html`, `maka-architecture.html`, `rag-pipeline.html`, `web-app.html`, `web-app-rendered.html` | Dotted canvas, restrained subsystem colors, compact cards, clear source inspector and related views. |
| `checkout-platform-delta.html` | Separate change information from the base architecture; retain directional edges and readable labels. |
| `class-payment-processors-rendered.html`, `class-payments-rendered.html` | Distinguish class members, inheritance and implementation relationships. |
| `dataflow-product-analytics.html`, `erd-orders-rendered.html` | Preserve domain labels, transfer direction, field details and meaningful legends. |
| `sequence-cache-miss-request.html`, `sequence-cache-miss.html` (redirect) | Play messages in authored order, including replies; connect the active arrow to a written step. |
| `lifecycle-agent-run.html`, `subscription-billing-rendered.html`, `workflow-agent-tool-call-rendered.html`, `workflow-agent-tool-call.html` (redirect) | Explain states, transitions and route controls without implying unsupported execution order. |
| `timeline-archify-dev-activity-rendered.html`, `timeline-payment-incident-rendered.html` | Preserve temporal ordering and explicit timezone controls. |
| `tree-archify-repository-rendered.html`, `tree-payment-platform-rendered.html` | Keep hierarchy and parent navigation clear. |
| `waterfall-checkout-request-rendered.html`, `waterfall-example-rebuild-rendered.html` | Keep durations and dependencies distinct from animated playback. |

## Review coverage behavior

Architecture, reuse, abstraction, dependency-boundary and dead-code checks use complete relevant source bodies instead of relying on the block's 60-line context window. Consolidation uses implementations and saved project standards. Both receive the available full architecture map, a fresh inventory of eligible repository sources (including tests), lexical reference search and relative-import relationships. Imported dependencies are followed transitively; changed files take priority, then dependencies, callers and related implementations.

This is a bounded component review against repository context, not a claim that every byte in an arbitrary repository fits into one model call. The prompt lists unsearched paths, omitted bodies and directories, and explains unresolved aliases and dynamic imports. A missing or oversized changed file stops the component check with an error; it does not become a passing verdict. Source reads remain confined and redacted, and isolated rule checks still evaluate only their own rule.

Automated checks cover playback order and focus, gaps and verified references, scan phase events, complete component bodies with callers beyond the old window, remote consumers, unsupported paths and source budgets. Human usability tasks and live rendered comparisons remain outstanding.

## Follow-up product requirements

- A diagram needs a plain-language introduction, not just a generic question. Keep the current scope explicit and change the explanation when the selection changes.
- Every card needs a responsibility or a clearly labelled structural description. Never reuse a file's purpose as though it explains every declaration in that file.
- Sequence participants need wrapped responsibility text. Class/interface cards need a type label and distinct UML compartments; technical members start hidden.
- Scan recommendations should explain why a representation fits. They must not fabricate order, runtime behavior or timing, or override the user's view selection.
- Every page needs contextual questions and source links. Keep follow-up dialogue scoped to its selection/revision and discard responses for a superseded view.
- Before commit must answer what changed, what may motivate it, and what needs attention. Show recorded review failures separately from tests. No evidence of a test run means unknown, not passed. Developer-reported verification must be labelled and invalidated when the captured changes change.
- AI reviews must be able to request missing evidence and stop as incomplete when that evidence remains unavailable.

Additional automated checks cover responsibility text in all ten layouts, sequence header/message separation, UML compartments, stale question responses, bounded valid question context, source buttons, before-commit interactions and AI-requested context expansion. These checks supplement the human acceptance tasks above; they do not replace a rendered visual review or a human usability session.

An independent final product review identified and drove fixes for explicit-item navigation retaining an earlier selection, unrelated context displacing a selected connection, missing authored diagram sources, revision-incorrect source links, hidden UML members reappearing in tooltips, incomplete Git coverage counts, stopped-reviewer actions and keyboard focus after redraw. Verify those transitions during the human acceptance session as well.
