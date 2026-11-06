# Layers and presets

Config layers, lowest first:

1. The user file, `$XDG_CONFIG_HOME/maestro/config.yaml` (default `~/.config/maestro/config.yaml`).
2. The workspace file, `.maestro/config.yaml`.
3. Each preset a `--preset <name>` names, in order.
4. Each `-c <key>=<value>` flag.

`maestro config <c> [param flags]` shows each value with its layer, file and line. A required param no layer gives shows
as `unset`; `config` checks nothing else and exits 0.

## Merging

Maps merge by key; a list in a higher layer replaces the lower one. YAML tags change that:

- `!replace` on a map replaces the lower map.
- `!append` on a list appends to the lower list.
- `!delete` on a key drops it.

## Presets

A preset is `<name>.yaml` in the workspace's `.maestro/presets/`, else the user's `$XDG_CONFIG_HOME/maestro/presets/`;
the workspace's wins the name whole. `--preset <name>` applies it on any verb.

```yaml
# .maestro/presets/cheap.yaml: the builder on a cheaper model; its harness and thinking merge from below
profiles:
  builder: { runtime: { model: haiku } }
```

The stub preset, for a no-spend concert, is in [stub.md](stub.md).

## One-off keys

`-c <key>=<value>` layers one key over the presets, its value YAML with the same tags:
`-c profiles.builder.runtime.model=haiku`, `-c 'packs=!append [../b]'`, `-c target.checks.lint=!delete`. A key holding a
`.` goes in double quotes.

The record keeps each `-c` as typed, so secrets stay in the `.env`. A resume reapplies the concert's `--preset` and `-c`
but finds the record store by today's `dataRoot`: pass a `-c dataRoot=` again.
