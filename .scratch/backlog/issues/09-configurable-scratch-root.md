# Configurable scratch root

Status: needs-triage

Core gives each node instance its own scratch directory and deletes it once the outputs are moved into the artifact
area (ADR 0007). Where the root lives is core's for V1. A host whose default location is small or shared may need it
elsewhere: the predecessor hard-coded `mktemp`, never cleaned up, and a full temporary directory failed every later run
until someone cleared it by hand. Make the root a core config key when a deployment needs it.
