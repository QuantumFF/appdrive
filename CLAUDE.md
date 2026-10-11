# appdrive

Read `README.md` first: the leak table there is the contract. A change that opens any row of it
is a bug however useful it is.

- Bun + TypeScript, no runtime dependencies. `bun test` and `bunx tsc --noEmit` before every commit.
- The user's shell is fish: wrap bash in `bash -c '…'`. Use `pkill -x`, never `pkill -f`.
- Never start an X server on a display number `src/x11.ts` did not claim, and never pass
  `-displayfd` (see the `:1` incident in the README).
- Exercise changes against a real app with `bun scripts/check-invisible.ts <checkout>`. For
  walltare, pass `--env WALLTARE_DATA_DIR=<copy>` so the run cannot write the shared `.dev-data`.
- Page scripts in `src/page.ts` are template strings: no backticks inside them.
