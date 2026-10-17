# Spike 4: Bun spawns bubblewrap plus pi and streams JSON events

Verdict: **go**. bwrap 0.12.0 + pi 1.2.0 (default provider/model in this environment: github-copilot / gpt-5.4) work
under a compiled Bun binary. Streaming is incremental, a tool-using run lands its file only in the lane, and
`--die-with-parent` is the one thing that reaps the process tree. Kernel 4.18 / real RHEL 8 stays pending until
`rhel8-check.sh` runs there.

Code: `.scratch/s0-skeleton-spikes/spike4/` in change `zzrpmxxx`, restored with
`jj restore --from zzrpmxxx .scratch/s0-skeleton-spikes` (`build.sh` -> `out/spike4`). No args = sandbox probe,
streaming, prompt staging and cancel matrix against a stand-in child (`sh` script emitting JSON lines, stderr noise and
three grandchildren, one of which escapes via `setsid`); exits 0 on pass. `out/spike4 --pi` = real pi runs (spends
tokens; exits non-zero if a run fails or the cancel leaves survivors). Process tree is checked by scanning
`/proc/*/environ` for a per-run marker env var, so bwrap, its init, pi and every descendant are counted whatever their
pgid/session.

## Mount plan (what `bwrapArgv` builds)

```
bwrap --unshare-all --share-net --die-with-parent --new-session
  --ro-bind /usr /usr  --ro-bind /bin /bin  --ro-bind /lib /lib  --ro-bind /lib64 /lib64  --ro-bind /sbin /sbin   (those that exist)
  --ro-bind <each existing of /etc/resolv.conf /etc/hosts /etc/nsswitch.conf /etc/ssl /etc/pki /etc/ca-certificates /etc/passwd /etc/group>
  [pi only] --ro-bind <pi install dir> <same path>
            --bind ~/.pi/agent ~/.pi/agent          (read-write, see below)
  --proc /proc --dev /dev --tmpfs /tmp
  --bind <lane> /lane --chdir /lane
  --remount-ro /
  --clearenv --setenv PATH /usr/bin:/bin --setenv HOME /tmp --setenv MAESTRO_SPIKE_MARK <uuid>
  -- <cmd>
```

Notes:

- `--unshare-all` unshares user, ipc, pid, net, uts, cgroup; `--share-net` gives the net ns back (probe: 10 interfaces
  visible with it, 1 without).
- `--new-session` (setsid) is kept: it blocks TIOCSTI terminal injection. Side effect: the sandboxed tree is in a
  different session/pgrp than bwrap, so a process-group kill of bwrap's pgid does not reach it (see cancel).
- **`--remount-ro /` is needed.** bwrap's root is a writable tmpfs, so without it `echo x > /etc/x` and `/x` succeed (in
  memory, gone on exit, host untouched, but not "writes fail"). It must come after the last bind, because it makes
  `mkdir` for later mount points fail. `/tmp` (tmpfs, own mount) stays writable and ephemeral; that is deliberate (pi
  and tools want a scratch dir) and is the only writable thing besides the lane.
- Paths that had to be visible for pi to run (paths only): the pi install dir
  (`~/.local/share/mise/installs/pi/1.2.0/pi`, must be bound at the **realpath**, the `latest` symlink does not resolve
  inside the sandbox), and pi's config dir `~/.pi/agent/` (files used: `auth.json`, `settings.json`,
  `models-store.json`), plus the `/etc` network/TLS entries above. No env var carried credentials: this pi authenticates
  from `auth.json`. A provider that uses an env var key would need that passed with an explicit `--setenv`, never
  inherited (`--clearenv`).
- **pi needs its config dir writable, so V1 mounts `~/.pi/agent` read-write.** Owner ruling 2026-10-14: this matches the
  legacy system and is a known sandbox defect, tracked in the backlog. Reason: pi takes a lock by
  `mkdir settings.json.lock` next to `settings.json`. With the dir ro-bound, pi warns "Invalid settings file ... EROFS"
  and then reports "No API key found for the selected model" (misleading) and emits only the `session` event. Risk: a
  sandboxed agent can change pi's real config. Backlog candidate fix, which is what the spike binary builds today:
  `--tmpfs /pi-agent` with the three files bound ro on top and `PI_CODING_AGENT_DIR=/pi-agent`. It is in-memory and
  ephemeral, but an OAuth token refresh writes `auth.json` and would fail on a ro file bind. Not hit here (token was
  fresh), see follow-ups.
- Also used `--no-session` so pi does not write session files.

## Commands and output

### 1. Sandbox probe, 2. streaming, 3. prompt staging, 4. cancel matrix (no args)

```
$ .scratch/s0-skeleton-spikes/spike4/build.sh
$ .scratch/s0-skeleton-spikes/spike4/out/spike4; echo exit=$?
PASS bwrap on PATH -- /usr/bin/bwrap

== 1. mount plan probe ==
IN_LANE=ok
DENIED /usr/x
DENIED /etc/x
DENIED /x
DENIED /lane/../x
WROTE /tmp/x (tmpfs, ephemeral)
ls: cannot access '/home': No such file or directory
net_ifaces=10 procs=5
PASS write inside lane succeeds
PASS writes outside lane fail
PASS host / untouched
PASS --share-net restores host interfaces -- shared=10 unshared=1

== 2. streaming ==
[    29ms] event session
[    29ms] event tick
[   431ms] event tick
[   832ms] event tick
[  1233ms] event tick
[  1635ms] event tick
[  2036ms] event agent_end
PASS events arrive incrementally -- n=7 first=2007ms before exit, stderrBytes=40, nonJson=0

== 3. prompt staging ==
PASS 300 KB as one argv entry is refused (E2BIG) -- E2BIG
PASS 300 KB via stdin -- wc -c=307200
PASS 300 KB via file in lane (pi @prompt.md) -- wc -c=307200

== 4. cancel matrix (tree = bwrap, init, sh, sleeps, setsid-escapee) ==
SIGKILL bwrap pid die-with-parent=false              before=7 survivors=7 [bwrap(25402<539) sh(25403<25402) sleep(25404<25403) ...]
SIGTERM bwrap pid die-with-parent=false              before=8 survivors=7 [bwrap(25424<539) sh(25425<25424) sleep(25426<25425) ...]
SIGKILL process group die-with-parent=false          before=7 survivors=7 [bwrap(25447<539) sh(25448<25447) sleep(25449<25448) ...]
SIGKILL bwrap pid die-with-parent=true               before=7 survivors=0 [none]
SIGTERM bwrap pid die-with-parent=true               before=7 survivors=0 [none]
SIGKILL process group die-with-parent=true           before=8 survivors=0 [none]
SIGKILL parent (sh) only die-with-parent=false       before=8 survivors=8 [bwrap(25503<539) bwrap(25504<25503) sh(25505<25504) ...]
SIGKILL parent (sh) only die-with-parent=true        before=9 survivors=0 [none]
PASS --die-with-parent + SIGKILL bwrap reaps tree
PASS --die-with-parent reaps tree when parent dies

ALL PASS
exit=0
```

(Survivors are killed by the spike after each row so nothing leaks. `<539` is the host's subreaper: orphans got
reparented to it.)

### Pi runs (`--pi`)

```
$ .scratch/s0-skeleton-spikes/spike4/out/spike4 --pi; echo exit=$?     # consecutive thinking_delta/toolcall_delta lines collapsed here
== pi A: streaming, prompt via stdin ==  pi -p --mode json --no-session --no-tools  (prompt on stdin)
[   323ms] session
[   325ms] agent_start
[   325ms] turn_start
[   325ms] message_start/system
[   325ms] message_end/system
[   325ms] message_start/user
[   325ms] message_end/user
[  1615ms] message_start/assistant
[  1615ms] message_update/text_start
[  1718ms] message_update/text_delta
[  1761ms] message_update/text_end
[  1788ms] message_end/assistant
[  1789ms] turn_end/assistant
[  1789ms] agent_end
[  1791ms] agent_settled
exit=0 signal=null events=15 nonJson=0 stderrBytes=0 usageKeys=[input,output,cacheRead,cacheWrite,reasoning,totalTokens,cost] tokens=436 cost=0.0012

== pi B: tool use, prompt via @file ==  pi -p --mode json --no-session @prompt.md
... session, agent_start, turn_start, system/user message pairs, message_start/assistant,
    message_update/thinking_start, ~80x thinking_delta, thinking_end, toolcall_start, ~10x toolcall_delta, toolcall_end,
    message_end/assistant, tool_execution_start/write, tool_execution_end/write, message_start/message_end toolResult, turn_end,
    turn_start, message_start/assistant, text_start, text_delta, text_end, message_end, turn_end, agent_end, agent_settled
exit=0 signal=null events=116 nonJson=0 stderrBytes=0 ... tokens=2438 cost=0.0071
lane files: hello.txt, prompt.md; hello.txt="hi\n"
hello.txt elsewhere on host: [none]            # find /home /tmp /var/tmp /root -name hello.txt -newer <stamp>, excluding the lane

== pi C: cancel while a bash tool child runs ==  pi -p --mode json --no-session --tools bash Run the bash command `sleep 4711` with a timeout of 600 seconds. Do nothing else.
... tool_execution_start/bash
   tree before kill: bwrap(25205<25143) bwrap(25206<25205) pi(25207<25206) sleep(25224<25207)
   after SIGKILL bwrap (die-with-parent): survivors=0 [none]
exit=null signal=SIGKILL events=104 nonJson=0 ... tokens=688 cost=0.0029
```

The "hello.txt only in the lane" result is an observation backed by a `find`, not an assertion. Real confinement is
proven by the stand-in probe (section 1).

Incremental arrival is real: in A the 7 header/system/user events land at ~325 ms, the assistant events at +1.3 s when
the model answers, in B the thinking and tool-call deltas arrive in 20-50 ms bursts; nothing is buffered to exit.

## Event schema sample (pi 1.2.0, `--mode json`)

Framing: strict JSONL, LF-terminated, one object per line (pi's `docs/json.md` says do not use readline, split on LF). 0
non-JSON stdout lines, 0 bytes of stderr in all three healthy runs. First line is a header, then session events.
Top-level keys per event, with the nested discriminator after `/`:

```
session: type,version,id,timestamp,cwd                         (header; cwd was /lane)
agent_start / turn_start: type
message_start|end/<role>: type,message                         role = system | user | assistant | toolResult
message_update/<ame.type>: type,usage,assistantMessageEvent    ame.type = text_start|text_delta|text_end|thinking_start|thinking_delta|thinking_end|toolcall_start|toolcall_delta|toolcall_end
tool_execution_start/<tool>: type,toolCallId,toolName,args
tool_execution_end/<tool>:   type,toolCallId,toolName,result,isError,durationMs
turn_end/assistant: type,message,toolResults
agent_end: type,messages,willRetry
agent_settled: type,aborted
```

Redacted samples (strings over 40 chars truncated):

```
{"type":"session","version":3,"id":"01a1…","timestamp":"2026-10-14T15:12:31.806Z","cwd":"/lane"}
{"type":"message_start","message":{"role":"system","content":"","sections":{"preamble":"You are an expert coding assistant opera…(169)","tools":"…(124)","rules":"…(97)","docs":"…(1301)","cwd":"<cwd>\n/lane\n</cwd>"},"timestamp":1791990772907}}
{"type":"message_update","usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0,"cost":{…}},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"ok"}}
{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"ok","textSignature":"…(454)"}],"api":"openai-responses","provider":"github-copilot","model":"gpt-5.4","usage":{"input":431,"output":5,"cacheRead":0,"cacheWrite":0,"reasoning":0,"totalTokens":436,"cost":{"input":0.00108,"output":0.000075,"cacheRead":0,"cacheWrite":0,"total":0.00115}},"stopReason":"stop","timestamp":…,"responseId":"…(420)","rawStopReason":"completed","durationMs":1861,"thinkingLevel":"medium"}}
{"type":"message_update",…,"assistantMessageEvent":{"type":"toolcall_end","contentIndex":1,"toolCall":{"type":"toolCall","id":"call_…|…(446)","name":"write","arguments":{"path":"hello.txt","content":"hi\n"}}}}
{"type":"tool_execution_start","toolCallId":"call_…","toolName":"bash","args":{"command":"sleep 4711","timeout":600}}
{"type":"tool_execution_end","toolCallId":"call_…","toolName":"write","result":{"content":[{"type":"text","text":"Successfully wrote to hello.txt"}]},"isError":false,"durationMs":1}
{"type":"agent_settled","aborted":false}
```

### Things R-4 should worry about

Verdict on the schema: **sufficient, stability unproven.** The evidence is one pi version (1.2.0), one provider
(github-copilot) and 3 runs, and several fields look provider-specific and unstable (listed below).

- **Token usage is only authoritative at `message_end` (assistant)**: `message.usage` =
  `{input,output,cacheRead,cacheWrite,reasoning,totalTokens,cost:{input,output,cacheRead,cacheWrite,total}}`. The
  top-level `usage` on every `message_update` stayed all zeros in these runs (pi's docs say it can stay zero until
  completion). Sum `message_end` over assistant messages, do not trust updates. A killed run has the usage of completed
  messages only. Cost is provider-computed dollars; may be 0 for some providers.
- `message_update` volume is high (thinking and tool-call argument deltas, ~100 lines for a 2-turn run) and each carries
  a `usage` object. The adapter should ignore deltas it does not display. `agent_end.messages` repeats the whole
  transcript, and the system `message_start/end` carries the full system prompt `sections`: large lines, never log them
  raw.
- Tool call/result ids contain a `|` plus a long opaque suffix, treat as opaque strings.
- `agent_end` is not the end: `willRetry`, and the real terminal event is `agent_settled` (`aborted`). Treat process
  exit plus `agent_settled` together; a failed run still exits 1 after the header (the EROFS case produced `session` and
  nothing else, error text only on stderr, so adapters need stderr capture for diagnostics).
- Fields observed that look provider-specific and likely unstable: `message.api`, `provider`, `model`, `responseId`,
  `rawStopReason`, `textSignature`, `thinkingLevel`, `sections`. The contract that looks stable (not proven) is `type`,
  `message.role`, `assistantMessageEvent.type/contentIndex/delta`, `toolName`, `args`, `isError`, `usage`. Pin the
  schema with fixtures (ADR 0001, see S8d follow-up) and tolerate unknown keys/types.
- `session.version` is 3; pi bumps it when the format changes, which is a cheap guard to assert on.
- Agent-chosen tool args (e.g. `timeout` on bash) show up in `args`.
- Healthy runs wrote nothing to stderr. Startup problems (config dir, missing auth) only appear on stderr and look like
  auth errors even when the cause is a read-only config dir.

## Prompt staging

`pi --help` / `docs/cli.md`: positional `message`, `@path` (text file or image, resolved from cwd), and **piped stdin
which is prepended to the first prompt**. Linux limits a single argv string to 128 KiB (`MAX_ARG_STRLEN`): the spike
shows a 300 KB argument is refused with E2BIG. Delivery paths proven with a stand-in through bwrap: stdin (300 KB via
`proc.stdin.write/end`) and a file inside the lane (300 KB `wc -c` = 307200). For pi itself, both paths were proven end
to end with tiny prompts: A used stdin ("reply with the word ok"), B used `@prompt.md` from the lane. No 300 KB prompt
was sent to a model. Preferred for S8c: write `prompt.md` into the lane and pass `@prompt.md` plus a short instruction
(also leaves an audit copy in the lane); stdin works too. Caution: with stdin as a pipe pi waits for EOF, so always
`end()` it, or pass `"ignore"` (/dev/null) when there is none (that is what B and C do).

## Cancel and process-tree kill

Two bwrap processes exist per run: the outer one (the pid Bun gets) and an inner one that is pid 1 of the new pid ns and
does `setsid` for `--new-session`. In the table, the binary asserts only two rows: `die-with-parent=true` with SIGKILL
of the bwrap pid, and `die-with-parent=true` with the parent killed. All other rows are printed observations, not
assertions. Result matrix (stand-in tree of 7 processes incl. one `setsid` escapee; the pi run C confirms the winning
row with the real tree `bwrap, bwrap, pi, sleep`):

| Kill                                                   | without `--die-with-parent`                                                | with `--die-with-parent` |
| ------------------------------------------------------ | -------------------------------------------------------------------------- | ------------------------ |
| SIGKILL bwrap pid                                      | whole sandbox survives (inner bwrap + everything, reparented to subreaper) | tree gone                |
| SIGTERM bwrap pid                                      | whole sandbox survives                                                     | tree gone                |
| SIGKILL process group (`detached: true`, `kill(-pid)`) | whole sandbox survives (only outer bwrap dies, inner called setsid)        | tree gone                |
| SIGKILL the parent of bwrap (maestro dying)            | everything survives, incl. both bwrap                                      | tree gone                |

What reaps the tree: **`--die-with-parent`** (PR_SET_PDEATHSIG SIGKILL on the inner bwrap, whose death takes down the
whole pid ns, including `setsid` escapees). Then killing the outer bwrap pid (SIGKILL or SIGTERM) is enough, and so is
maestro crashing. Process-group kill alone does nothing because of `--new-session`; do not rely on it. Without
`--die-with-parent` there is no equivalent on the host side; the processes would need to be found by pid ns / cgroup.

Pi run C, real pi + tool child: tree `bwrap(25205) > bwrap(25206) > pi(25207) > sleep(25224)`, `SIGKILL` on the outer
bwrap, 0 survivors within the 2.5 s poll. pi spawns its bash tool child directly (no intermediate shell visible in the
tree for `sleep 4711`).

## Caveats

- Tested on this WSL2 box (kernel 6.18, merged-/usr Linux, bwrap 0.12.0). The RHEL 8 bwrap is likely an older release
  than 0.12.0 (not checked here; confirm `--remount-ro`, `--die-with-parent`, `--new-session` there) and user namespaces
  may be disabled (`user.max_user_namespaces=0`). The no-args run on the real host answers this; if bwrap is missing or
  userns are off the binary reports FAIL and exits 1.
- `--remount-ro /` ordering and `--ro-bind /bin /bin` on merged-usr (symlink source) worked here; on a non-merged host
  `/bin` is a real directory and is bound as such.
- Probe of ro-ness covers `/usr`, `/etc`, `/`, `..` of the lane; `/tmp` and `/pi-agent` are writable tmpfs by design.
- The cancel test only used SIGKILL on a pi that was mid tool call, not mid model request. SIGTERM graceful abort of pi
  (does it emit `agent_settled aborted:true`?) was not tried; with `--die-with-parent` plus SIGTERM to bwrap the tree is
  killed hard with no final event.
- OAuth refresh (github-copilot here) writes `auth.json`; on a ro bind that write fails. Not hit, not tested.
- Real-model checks do not run in no-args mode, so on the RHEL 8 host without pi only the stand-in checks run.

## Follow-ups

- **S8b (sandbox/supervision):** use the mount plan above as the base policy (pi config dir RW per backlog 01)
  (`--remount-ro /` after the binds, `--clearenv`, `--new-session`, `--die-with-parent` mandatory). Cancel = SIGKILL the
  outer bwrap pid; assert no survivors by scanning for the marker (the `/proc/*/environ` trick works for tests).
  Per-harness extras (pi install dir at realpath, config dir) belong to the adapter, the policy stays host config.
  Decide the `/etc` allow-list (resolv.conf, ssl, pki, hosts, nsswitch, passwd, group) per distro; `/etc/resolv.conf`
  symlinks resolved fine here. Decide whether `/tmp` stays a tmpfs.
- **S8c (harness interface):** stage prompts as a file in the lane (`@prompt.md`) or stdin, never argv. Read stdout as a
  stream split on LF; keep a stderr capture (startup failures only show there). The stub harness should emit pi's event
  shapes, including `agent_settled`, to keep fixtures aligned.
- **S8d (pi adapter):** map `message_end` (assistant) usage to metrics, derive turns from `turn_start/turn_end`, tool
  calls from `tool_execution_*`, completion from `agent_settled` + exit code. Tolerate unknown event types and keys.
  Check `session.version`. Use `--no-session`. Resolve the OAuth refresh question (copy credentials per run into the
  tmpfs vs. host-side token refresh before launch). Pin the pi version and keep event fixtures per pi version. Consider
  `--no-tools`/`--tools` allow-lists per role. Graceful abort (stdin close or SIGTERM to pi inside the sandbox) is worth
  a separate check before relying on `agent_settled aborted:true`.

## Spend

Real model calls that reached the model: 6 short prompts (two full A/B/C passes: one while developing, one final), all
github-copilot / gpt-5.4. Two earlier attempts failed before reaching the model (bad exec path, then the config lock
error). Final pass: A 436 tokens (~$0.0012), B 2438 tokens (~$0.0071), C 688 tokens (~$0.0029); the first pass cost
about the same, so roughly $0.02-0.03 in total at the provider-reported rates. No credentials were printed, logged or
written; only file paths appear above.
