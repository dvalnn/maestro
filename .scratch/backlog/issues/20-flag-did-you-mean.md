# Did-you-mean for a mistyped flag

Status: needs-triage

Owner ruling 2026-10-16: a minor UX gap, tolerated for now. `maestro perform greet.ts --nmae x` says the flag is unknown
but does not suggest `--name`, while a mistyped config key gets a did-you-mean through `closest`. Reuse `closest` over
the verb's flags and the composition's param flags.
