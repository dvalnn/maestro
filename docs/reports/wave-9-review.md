# Wave 9 review: SDK and repo host API pass

One opus read-only pass over `jj diff --from mvoowmxp --to yxmnytoz`: L1 `loop.while` and `doWhile` replacing `repeat`,
L2 the `iter` suite replacing `map` and `seq`, A1 composition API naming and A2 one meaning per repo node word. The code
agrees with itself across the four changes: the SDK emits the group kinds the IR, compose and perform know, and the
fixtures and testkit moved to the new names. The faults sit in docs the renames never reached (ADRs 0004, 0006, 0008,
the port plan and sdk-spec 14, whose worked examples no longer type-check), in one list the SDK and host each keep, and
in a parFind check compose skips.

## Findings

| #   | Kind | Finding                                                                                   | Verdict                                                |
| --- | ---- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 1   | doc  | sdk-spec 14 `build_escalate` and `build_fanout` cannot type-check                         | Accepted: unroll over the `models` param[^k1]          |
| 2   | doc  | sdk-spec 14 `fix_until_green` and the lens example misuse the API                         | Accepted                                               |
| 3   | doc  | `tpl` survives in sdk-spec and the port plan after K245 cut it                            | Accepted                                               |
| 4   | doc  | ADR 0004 still describes `seq`, `repeat`, `map.onError` and a by-name `map` member record | Accepted                                               |
| 5   | doc  | Old names survive in ADR 0008, the port plan and architecture                             | Accepted                                               |
| 6   | doc  | ADR 0006's plan-panel consequence reads an agent `text` output no agent has               | Accepted                                               |
| 7   | code | The agent's own port names are listed in the SDK and the host, and the lists disagree     | Accepted: the host's list, pinned in the SDK by a test |
| 8   | code | Compose checks duplicate literal keys of a `parMap` only, not a `parFind`                 | Accepted                                               |
| 9   | code | The CLI imports `HOST_PATHS` from the repo host, outside the Host interface               | Raised: the Host names its path keys[^k2]              |
| 10  | code | The not-a-git-repository hint for `target.repo` names the wrong fix                       | Accepted                                               |
| 11  | code | Comments and a diagnostic doc name only parMap's key function, or a "map item key"        | Accepted                                               |
| 12  | code | The `loop.while` docstring and hint state a narrower test rule than K229                  | Accepted                                               |

## Detail

### 1. `build_escalate` and `build_fanout` cannot type-check

- **Where:** `docs/sdk-spec.md:429-445` (`builtOn`, `escalate`, `fanout`), `docs/sdk-spec.md:516` (the section 15 row),
  `docs/architecture.md:249` ("This covers escalation over models").
- **Citation:** D-16 and sdk-spec 5, line 187 ("a Ref never feeds a param"); K303 (the example is a conflict, to be
  corrected in the wave-review fixes).
- **Failure:** `builtOn` breaks in two places:
  - `use(fixUntilGreen, { build, prompt, model: m })` feeds `model`, a param, as a port. The extra key fails
    `PortValues<{ build, prompt }>` at compile time and `checkPorts` throws `TYPE.ports` at build
    (`packages/sdk/src/composition.ts:172`). Moving it to `opts.params` fails too: `m` is the `Ref<string>` item of
    `iter.find`, refused by `Partial<Values<P>>` and by `REF.param` (`composition.ts:137`).
  - `role: { name: "builder", model: m }` puts a Ref into a role, which is plain host config: `Role.model` is a `string`
    (`packages/host-repo-sdk/src/index.ts:126`) and `hostNode` refuses any Ref in config. A group item can never pick a
    model.

  `build_fanout` shares `builtOn` and fails the same way. Architecture 249 promises what no group can do.

- **Fix:** take one of these:
  - unroll over the plain `models` param at build, each try guarded by `when: not(prev.ok)` and fed
    `use(fixUntilGreen, { build, prompt }, { params: { model: m } })`, ending in `firstOk` over the tries' lanes; fanout
    becomes `firstOk(models.map(...))`;
  - or, per K303, `iter.find` over the plan's approaches fed to `task`, a port, and drop "escalation over models" from
    architecture 249 and the section 15 row.

### 2. `fix_until_green` and the lens example misuse the API

- **Where:** `docs/sdk-spec.md:404-418`, `docs/sdk-spec.md:451-474`.
- **Citation:** sdk-spec 5 (a Result handle's ports are structure, a Ref is not plain config); CORE-05 and
  `packages/sdk/src/nodes.ts:166-169` (no `max` over a written list); K216 (`results` is the group's output).
- **Failure:** neither example compiles against the SDK it documents:
  - `step: (checked) => verify(agent({...}))` hands an agent handle to `extend`, which takes a lane Ref; it needs
    `.out.lane`.
  - `role: job.lens` and `role: job.skeptic` read a field of a Ref by property, which `Ref` has no member for, and would
    put a Ref into a role.
  - `when: lens.out.findings.nonEmpty` reads a property no artifact Ref has.
  - `{ max: 14, ... }` over `jobs`: a written list takes no `max`.
  - `code(byFinding, { in: { runs } })` passes the group handle; the fixture form is `runs.out.results`.
- **Fix:** rewrite both from `packages/host-repo-sdk/src/fixtures/examples.ts` (`review`, `buildThenRepair`), which do
  type-check: the role from a plain param, `results` as the code node's input, `extend(repair.out.lane)` inside `step`.

### 3. `tpl` survives after K245

- **Where:** `docs/sdk-spec.md:183` (Templates), `:273` (stdlib Templating), `:362` (`TYPE` "template variable missing
  or mistyped"), `:411`, `:456`, `:464`, `:477`, `:493`, `:502`; `docs/port-plan.md:80`.
- **Citation:** K245 ("No `tpl` for V1: a prompt is a task plus an agent identity plus attachments").
- **Failure:** the spec lists a stdlib function and a compose diagnostic that do not exist, and every worked example
  calls it.
- **Fix:** drop the Templates and Templating bullets and the `TYPE` clause; in section 14 build the task in TS from
  plain values and pass run-time values as attachments; strike `tpl` from port-plan S2.

### 4. ADR 0004 describes the retired groups

- **Where:** `docs/adr/0004-ir-flat-graph-and-version-policy.md:17-18`, `:33`, `:40-42`.
- **Citation:** K216 and K237 (a one-handle body's member value is its outputs; a record is `{ name: outputs }`); global
  rule "keep docs in step with the code".
- **Failure:** `inner` and `out` are explained through `repeat`, `map` and `seq`; an alternative is still worded "a
  `seq`/`repeat` result field"; the consequences name `map.onError` and say "a `map` member result is a record keyed by
  result name" and "a `seq` or `repeat` takes exactly one member". The IR has `parMap`, `map`, `find`, `parFind`, `fold`
  and `loop`, and a one-handle member is not a record.
- **Fix:** reword with the new kinds: `inner` is `item`, or a loop's or fold's state; `out` is `results`, or the
  mirrored member's outputs; `parMap.onError` and `map.onError` have no default; a member value follows K237.

### 5. Old names in ADR 0008, the port plan and architecture

- **Where:** `docs/adr/0008-code-nodes-name-exported-functions.md:16-17`, `:31`, `:67`; `docs/port-plan.md:79-81`,
  `:105`; `docs/architecture.md:543`.
- **Citation:** K239 (`parFind` takes a key function as `parMap` does); D-27 and `docs/requirements.md:103` (the
  deferral is extending a lane across concerts); global rule "keep docs in step with the code".
- **Failure:**
  - ADR 0008 says "a `map` key function", "an `until`" and "a `repeat` step"; only `parMap` and `parFind` take a key,
    and `until` and `repeat` are gone.
  - Port-plan S2 lists `map`, `seq`, `repeat` and "map item keys"; S4 says "escalation (`seq`), `repeat` to its bound".
  - Architecture lists "a cross-concert join" among deferrals; the requirement names it extension.
- **Fix:** rename to `parMap`/`parFind` key functions, a `loop` test and step, `iter.find` and `loop`; say "extending a
  lane across concerts" in architecture 543. The port plan may instead keep its old wording with a note that L1 and L2
  renamed them.

### 6. ADR 0006's consequence reads a `text` output

- **Where:** `docs/adr/0006-*.md:61`.
- **Citation:** K237 (ADR 0006's consequence is reworded to match); sdk-spec 12.1 (an agent's outputs are `lane`,
  `report` and its declared outputs).
- **Failure:** `firstOk([synthesis.out.text, firstOk(plans).out.value.get("text")])` reads `text` from agents, which
  have no such output; sdk-spec 14 reads `report`.
- **Fix:** `firstOk([synthesis.out.report, firstOk(plans).out.value.get("report")])`.

### 7. The agent's own port names are defined twice

- **Where:** `packages/host-repo-sdk/src/index.ts:184`; `packages/host-repo/src/host/config.ts:23`, `:121`.
- **Citation:** CLAUDE.md "Does it already exist in this codebase? Reuse"; sdk-spec 12.1 (attachments and outputs may
  not take an agent's own port names).
- **Failure:** the SDK refuses `prompt`, `identity`, `lane`, `report` and `staged` for both attachments and outputs. The
  host refuses `prompt`, `identity` and `lane` for attachments, and `lane`, `report` and `staged` for outputs. So an
  attachment named `report` or an output named `prompt` is refused by the SDK and accepted by hand-written IR; one rule,
  two answers.
- **Fix:** export the host's two lists from `@maestro/host-repo` (as `AGENT_KIND` already is) and have the SDK refuse
  each against its own list, or settle in sdk-spec 12.1 that one list of five covers both, and use it in the host.

### 8. Compose skips duplicate literal keys of a `parFind`

- **Where:** `packages/core/src/compose/expand.ts:146` (`if (group.kind !== "parMap") return region;`).
- **Citation:** D-18 and SDK-13 (duplicate keys of a `parMap` or `parFind` are a compose error when known at build);
  `docs/architecture.md:242-246` ("`parFind` keys its items the same way").
- **Failure:** a `parFind` never expands, so compose never reports `SCOPE.key` for one over a written list with
  duplicate primitives. The SDK catches it at build, but IR from any other emitter composes clean and fails the group at
  perform (`keysOf` in `packages/core/src/perform/perform.ts`).
- **Fix:** run the key check for both kinds in compose; if `parFind` stays unexpanded, check its literal keys apart from
  expansion.

### 9. The CLI reaches into the repo host for `HOST_PATHS`

- **Where:** `packages/cli/src/config.ts:19`, `:38`; `packages/host-repo/src/host/config.ts:54`;
  `packages/host-repo/src/host/index.ts:16`.
- **Citation:** architecture section 6 and ADR 0010 (the Host interface is frozen and is the engine's only view of a
  host); implementation loop step 4 (a decision taken in code with no ADR or ruling).
- **Failure:** to anchor `target.repo` to its config file (K284), the CLI imports a list of host config paths straight
  from `@maestro/host-repo`. Any other host's relative paths would resolve against the cwd, and the CLI now knows one
  host's config layout. K284 rules the anchoring, not the seam.
- **Fix:** raise it: either a field on the Host interface naming its path-valued keys (an ADR 0010 amendment), or a line
  in ADR 0010 recording that path keys of built-in hosts are a CLI table.

### 10. The not-a-git-repository hint names the wrong fix

- **Where:** `packages/host-repo/src/host/validate.ts:375-381`.
- **Citation:** `CODING_STANDARDS.md` user-facing output and clig.dev (an error says what to do next).
- **Failure:** when `target.repo` exists but holds no `.git`, the hint says to set it relative to the config file's
  directory; the path resolved, so the likely fix is pointing it at a repository or running `git init`. The relative
  path hint belongs on the "does not exist" case at `:367-373`, where a wrong anchor is the likely cause.
- **Fix:** swap the hints: "does not exist" gets "Set 'target.repo' relative to the config file's directory"; "is not a
  git repository" gets "Point 'target.repo' at a git repository".

### 11. Comments name only parMap's key function

- **Where:** `packages/sdk/src/diagnostic.ts:8` ("a duplicate map item key"); `packages/core/src/node.ts:25`;
  `packages/core/src/shared.ts:22`; `packages/sdk/src/graph.ts:22`; `packages/core/src/compose/checks.ts:527`;
  `packages/core/src/compose/README.md:34`; `packages/cli/src/loader.test.ts:51`.
- **Citation:** K239; global rules "keep docstrings in step with the code" and passive cleanup.
- **Failure:** since L2 a `parFind` takes a key function too, and `map` is now the sequential group, which has no keys.
  Each comment states a narrower or wrong rule.
- **Fix:** say "a `parMap` or `parFind` key function" and "a duplicate item key".

### 12. The `loop.while` docstring is narrower than K229

- **Where:** `packages/sdk/src/nodes.ts:608` (docstring), `:601` (`WHILE_HINT`).
- **Citation:** K229 (a test-first loop's test node and every body node it reads, transitively, run before the step);
  global rule "keep docstrings in step with the code".
- **Failure:** the docstring says "one node that reads only the state", and the `REF.bool` hint "one node made from the
  state alone"; the ruling and `packages/ir/src/graph.ts:156` admit a test that reads body nodes transitively, refusing
  only a chain that reaches the step.
- **Fix:** both say "a Bool port of the state, or a Bool output of a node built from the state, not from the step".

## Loop

| Step        | Findings | Accepted     | Changed code or design                                                                              | Spend[^1]             |
| ----------- | -------- | ------------ | --------------------------------------------------------------------------------------------------- | --------------------- |
| Wave review | 12       | 11, 1 raised | code (compose parFind keys, host path keys, hints); docs (sdk-spec 14, ADRs 0004, 0006, 0008, 0010) | opus high, 86k, 9 min |

[^1]: Model, then tokens and wall time from each agent's notice.

[^k1]:
    Each model try is its own `use` with the model as a plain param, guarded by the last try's failure, ending in
    `firstOk`; escalation over models stays, so architecture 249 and the section 15 row stand.

[^k2]:
    `Host` gains an optional list of its path-valued config keys, and the CLI anchors those instead of importing
    `HOST_PATHS`; ADR 0010 says so. Logged as an overnight contract call.
