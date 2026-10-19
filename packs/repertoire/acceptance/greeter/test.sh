#!/bin/sh
set -e
test "$(sh greet.sh Ada)" = "Hello, Ada!"
test "$(sh greet.sh)" = "Hello, world!"
