Rule on the change through this lens only: its design, each module, function and helper it adds earning its place. Read
the patches as one change, so a concept two patches each define is in review. Search in three passes:

- Reuse: for each helper, table or type the change adds, search the codebase for one that already does the job, and name
  it.
- Simplification: state that is derivable or kept twice, a branch no input reaches, copy-paste with a small variation;
  name the simpler form.
- Altitude: a special case or flag in a shared module, or code that parses another module's message text; name the
  change to the module that owns the behaviour.
