# Docs map

Where each topic lives. A topic has one home that states it in full; every other doc that needs it links there and adds
at most one line of context. Before adding to a doc, find the topic here; a new topic gets a row first.

## Ownership rules

Which kind of doc owns a topic:

- **`--help`**: commands, flags, aliases and exit codes. Docs add only what help cannot say.
- **Package README**: the package's format, rules and contents. Signatures stay in TSDoc.
- **`docs/architecture.md`**: runtime behaviour across packages, summarised, linking down to package READMEs.
- **`docs/sdk-spec.md`**: what an author writes and can rely on. Engine internals link out.
- **`docs/requirements.md`**: requirements by id, citing decisions by id.
- **`docs/rulings.md`**: the decision register (D-nn, R-nn), one line of decision plus its why.
- **`docs/adr/`**: a decision that weighed alternatives.
- **`.maestro/`** prompts and presets: the factory's formats and review tiers. Docs describe the flow and link in.
- **`GLOSSARY.md`**: one-line definitions and the naming rule. A rule inside an entry moves to its home.

The shipped skills (`skills/`) sit outside this map. They may restate what a repo doc owns, and they are never a topic's
home; no repo doc links into them for its facts.

## Topics

### Engine and IR

| Topic                                    | Home                                  | Links in from                      |
| ---------------------------------------- | ------------------------------------- | ---------------------------------- |
| Packages and dependency rule             | architecture: Layers and packages     | requirements                       |
| Concert lifecycle (compose → perform)    | architecture: Lifecycle of a concert  | requirements, sdk-spec, CLI README |
| Pre-flight steps                         | `packages/core/src/compose/README.md` | architecture                       |
| IR contents and wire format              | `packages/ir/README.md`               | architecture, sdk-spec             |
| Group behaviour (keying, onError, loops) | architecture: Execution model         | sdk-spec, IR README[^groups]       |
| Group field shapes, `itemKey` alphabet   | `packages/ir/README.md`               | sdk-spec, compose README           |
| Outcomes, result rule, tolerance         | architecture: Execution model         | sdk-spec, IR README, glossary      |
| Resume and code-hash reuse               | architecture: Execution model         | CLI README                         |
| Worker protocol                          | architecture: Workers and code nodes  | sdk-spec                           |
| Record store, events, data root          | architecture: Record and events       | IR README, CLI README              |
| Static and live rendering                | `packages/render-text/README.md`      | architecture, CLI README           |
| Host interface (members)                 | architecture: Host interface          | ADR 0010 holds the why             |
| Packs: manifest, discovery, trust        | architecture: Packs                   | INSTALL, ADR 0002                  |

### Configuration

| Topic                                      | Home                           | Links in from                   |
| ------------------------------------------ | ------------------------------ | ------------------------------- |
| Precedence ladder, layers                  | architecture: Configuration    | requirements, rulings, sdk-spec |
| Merge tags, presets and `-c` syntax        | CLI README: Config             | architecture, INSTALL           |
| Core config keys                           | architecture: Configuration    | CLI README                      |
| Host config keys (`target`, `profiles`, …) | `packages/host-repo/README.md` | CLI README, INSTALL             |

### Authoring

| Topic                                        | Home                       | Links in from    |
| -------------------------------------------- | -------------------------- | ---------------- |
| Node constructors and refs                   | sdk-spec                   | IR README        |
| Writing a composition: file rules            | sdk-spec                   | CODING_STANDARDS |
| Composition and prompt authoring[^authoring] | sdk-spec, host-repo README | CODING_STANDARDS |
| Diagnostic catalogue (prefixes)              | sdk-spec                   | compose README   |
| Lane builders as an author writes them       | sdk-spec: Repo host SDK    | host-repo README |
| Classics compositions and profiles           | `packs/classics/README.md` | INSTALL          |

### Repo host

| Topic                                     | Home                                 | Links in from                    |
| ----------------------------------------- | ------------------------------------ | -------------------------------- |
| Agent node, staging, outbox, envelope     | `packages/host-repo/README.md` (new) | architecture, glossary, ADR 0012 |
| Context policy, handoff, compaction       | `packages/host-repo/README.md`       | ADR 0014                         |
| Lane mechanism and versions               | `packages/host-repo/README.md`       | requirements, sdk-spec           |
| Changesets and apply                      | `packages/host-repo/README.md`       | CLI README                       |
| Profiles: fields, lookup, limits, prompts | `packages/host-repo/README.md`       | sdk-spec, CLI README, ADR 0013   |
| Sandbox and harness adapters              | `packages/host-repo/README.md`       | ADR 0001                         |
| Checks, prepare, sparse                   | `packages/host-repo/README.md`       | CLI README                       |
| Stub harness, `MAESTRO_STUB_*`            | `packages/host-repo/README.md`       | CLI README, INSTALL              |

### Operating maestro

| Topic                                       | Home                     | Links in from                |
| ------------------------------------------- | ------------------------ | ---------------------------- |
| Install, first run, upgrade, uninstall      | `INSTALL.md`             | CLI README                   |
| Perform, detach, closing block              | `packages/cli/README.md` | implementation-loop          |
| Watch, ls, artifact, changeset, agent show  | `packages/cli/README.md` | render-text README           |
| Resume, encore, kill, prune, tours          | `packages/cli/README.md` | architecture                 |
| Short ids and naming instances              | `packages/cli/README.md` | glossary, render-text README |
| Output conventions (`--json`, color, pager) | `packages/cli/README.md` |                              |

### Decisions and requirements

| Topic                           | Home                   | Links in from      |
| ------------------------------- | ---------------------- | ------------------ |
| Requirements (CORE-, HOST-…)    | `docs/requirements.md` | code, architecture |
| Decisions D-nn and rulings R-nn | `docs/rulings.md`      | requirements, code |
| Decisions with alternatives     | `docs/adr/`            | rulings            |

### Factory and repo process

| Topic                                                           | Home                                          | Links in from                          |
| --------------------------------------------------------------- | --------------------------------------------- | -------------------------------------- |
| Tour manager states and rules                                   | `docs/agents/factory.md`                      | issue-tracker, triage-labels, glossary |
| Label meanings                                                  | `docs/agents/triage-labels.md`                | factory                                |
| Spec format, routes, spec check, PR bodies                      | `.maestro/triage/`, `.maestro/slice/` prompts | factory                                |
| Plain English for specs, PR bodies and docs                     | `.maestro/triage/prompts/_plain.md`           | Doc conventions                        |
| Forge comments the tick writes[^surfaces]                       | `docs/agents/factory.md`: Forge surfaces      | `scripts/factory/`                     |
| Review depth tiers                                              | `.maestro/slice.ts`, `.maestro/presets/`      | factory                                |
| Tick install, `.env`, flags, exit codes                         | `scripts/factory/README.md`                   | factory                                |
| Issue shape, brief and report                                   | `docs/agents/issue-tracker.md`                | implementation-loop                    |
| Hand-driven slice loop, release review                          | `docs/agents/implementation-loop.md`          | CLAUDE.md, release skill               |
| Commit messages                                                 | `CLAUDE.md`                                   | jj skill                               |
| Release and semver policy                                       | `.claude/skills/release/SKILL.md`             | CLAUDE.md                              |
| Review standards for this repo's code, compositions and prompts | `CODING_STANDARDS.md`                         | CLAUDE.md                              |

[^groups]:
    architecture says what a group does when it runs; the IR README says what its fields look like. sdk-spec keeps one
    line per constructor and links to both.

[^authoring]:
    General advice for anyone writing a composition or a prompt. Rules binding this repo's own `.maestro/` and `packs/`
    stay in `CODING_STANDARDS.md`.

[^surfaces]:
    The closing line, the spec comment with its `maestro-tm-data` line, and question comments: one fenced skeleton each.
    The tick's code cites this section, as it already cites the factory rules.

## Doc conventions

Every doc follows these when rewritten:

- A reader line under the title: who reads it, and when.
- Real `##`/`###` headings; no bold pseudo-headings or footnotes standing in for sections.
- Lean tables: one-line cells, detail in footnotes.
- A Mermaid diagram wherever prose walks a flow, a state machine or a graph, checked with `forge-diagrams`.
- No history, dates, draft status, ticket ids or migration notes; those live in version control and release notes.
- Links to headings by name, never "section 12". Headings that code comments cite keep their names.
- Prose in plain English, by `.maestro/triage/prompts/_plain.md`.
- Lines reflowed to 120 characters.
