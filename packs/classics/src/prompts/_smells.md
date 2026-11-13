The shape of the code, each smell confirmed in the code before you raise it, and none that tooling already enforces. A
documented repo standard wins over an item: where it endorses what an item flags, the item is met.

1. Every new name says what it does or holds.
2. Values that travel together are one type, and a domain concept the change leans on has its own type, not a bare
   primitive or string.
3. One logical change touches one module, and each touched module changes for one reason.
4. No function reaches into another object's data more than its own, or walks a chain its caller should not depend on.
5. No switch on the same type recurs across the change, and no implementer ignores most of what it inherits.
