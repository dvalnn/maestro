The design of the change, each module, function and helper it adds earning its place. Read the patches as one change, so
a concept two patches each define is in review.

1. Reuse: for each helper, table or type the change adds, search the codebase for one that already does the job, and
   name it.
2. Simplification: no state that is derivable or kept twice, no branch no input reaches, no copy-paste with a small
   variation; name the simpler form.
3. Altitude: no special case or flag in a shared module, and no code that parses another module's message text; name the
   change to the module that owns the behaviour.
4. No pass-through wrapper: a function, class or module that only delegates onward, whose deletion removes no
   complexity.
5. Each new or changed module is deep: a small interface over much behaviour, which deleting would spread over its
   callers rather than remove.
6. Each new seam has something that varies across it, two adapters rather than one hypothetical.
7. Tests and callers cross a module at the same interface; none reaches past it.
