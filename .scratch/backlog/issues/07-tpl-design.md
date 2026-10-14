# `tpl` has no IR representation or variable declaration

Status: needs-triage

Owner ruling 2026-10-15: out of wave 3. `tpl` leaves S2, and the template variable check leaves S3. A design note or
ADR comes first, before S8e or S9, which are the first slices that need prompts.

Open points:
- How `tpl` appears in the IR. The likely answer is a stdlib pure code node with the template file as a declared read
  and the variables as input ports.
- Where a template declares its variables, so compose can check them (architecture section 4, step 4.2). Parsing the
  file during build reads a file under frozen ambient state (SDK-11).
- Whether prompts need a `core.text` artifact type (see backlog 06).
