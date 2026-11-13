Each path the change adds or touches does what it claims, its error paths included. Read each hunk with the whole
function around it, and for each function it touches read every caller and callee.

1. Every changed line holds for every input, state and order.
2. Each guarantee a removed or replaced line gave still holds in the new code.
3. Every caller and callee of a touched function still works with what a changed call throws, returns or needs first,
   and no sibling caller the change left alone is now wrong.

Give each finding on items 1 to 3 the concrete input that makes it fail.
