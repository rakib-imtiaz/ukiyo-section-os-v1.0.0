<!-- tbr-canary-9d02e6b1c457 -->
## Finish (mandatory)

When this step is done — even if parts of it could not be completed — write the file `{{SIGNAL}}` containing a short plain-text summary: what you did, which files you wrote, and anything left undone and why. Its existence is how the factory knows this step finished; then exit. Do not start the next step's work: it runs in its own session.

If you hit a blocker instead, write `qa/reports/BLOCKED.md` (for a project identity mismatch: `qa/reports/ABORTED.md`) as described above and exit without writing `{{SIGNAL}}`.
