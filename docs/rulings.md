# Rulings

Owner decisions with lasting weight that no requirement, ADR or package README states. Each one says what holds, why
when that is not obvious, and where it applies. A ruling that grows into a design moves to an ADR and leaves this file.

## Resume

- **Resume runs under the config as it stands.** `perform --resume` re-runs pre-flight under the current config and
  hosts, then performs the stored IR with its code hashes recomputed. The record keeps `--profile` and `-c` as typed,
  and a resume reapplies them over the config files as they stand. The resume key holds no config beyond a host node's
  own, so a changed profile alone reruns no `ok` instance. Why: the IR is the build's snapshot, and config resolved at
  perform and code pinned by hash are its intended edges. Applies in `packages/cli/src/prepare.ts` (`resumable`) and
  `packages/core/src/perform/resume.ts`.

## Roles

- **The command line has the last word on a role.** Per field, highest first: `--profile` and `-c`, the composition's
  inline role fields, the config files' `roles`. So `--profile stub` always means no spend, an author can still pin a
  model over the workspace default, and `-c roles.x.model=...` changes only the model. A resume applies the same order,
  as it reapplies the recorded `--profile` and `-c`. Why: the person running the concert answers for the spend. Applies
  in `packages/host-repo/src/host/config.ts` (`roleFields`) and `packages/core/src/config/index.ts` (`commandLineOf`). A
  `!replace` of a role on the command line replaces it whole, inline fields included.

## Concert fork (deferred)

Starting a concert from an earlier concert's results is wanted, once the coding-agent host's lanes exist. It takes the
place of a result cache across concerts, which V1 does not have. Its shape is settled:

- Selection is by name. A composition with ports may run at the root. The CLI feeds each port from a recorded node
  instance of an earlier concert, written `<concert id>.<node instance id>` like a lane ref. This lifts sdk-spec 2's
  rule that a composition with ports runs only through `use`.
- Each port's schema is checked against the recorded outputs before any spend. A missing instance, a non-`ok` one or a
  type mismatch is a usage error.
- Values are copied into the new concert's record. Artifacts come in by content hash, so pruning the earlier concert
  stays safe. Lanes are fork-only. A map instance feeds its `results`.
- Rejected: re-declaring a prefix and reusing each node whose key matches a recorded one. Its misses are silent and they
  spend.

## IR files

- **Hand-written IR proves IR-01 through the golden fixtures.** It runs when it is correct. No effort goes to edge cases
  that only hand-written IR can express. The loader still refuses an IR-file module that imports anything but builtins
  and `@maestro/sdk`, since the same check guards pack entries. Applies to `packages/ir/fixtures/` and
  `packages/cli/src/loader.ts`.

## CLI

- **`config` prints values as they are, secrets included.** It writes to the operator's own stdout, not to a log or the
  record. Masking waits for secret handling (D-33). Applies in `packages/cli/src/compose.ts`.
- **Each command reads and writes one record store**, the one `dataRoot` resolves to. `ls` has no `--all`, because
  listing other stores needs workspace discovery, which maestro does not do. A host-specific `ls` column, such as a
  target, would come through the host's hooks, never from `cli`.

## Agents

- **An agent may carry limits on its wall clock and tokens (HOST-08).** They bound one agent instance, not a concert, so
  D-23's exclusion of cost and concert-wide budgets stands. Applies in `packages/host-repo/src/host/agent.ts`.
