# aica-mend

[![make.fun bounty](https://img.shields.io/badge/make.fun-hidden--spec--cli-blue)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

mend: one command-line tool that applies AI-written edits in four formats — unified diffs (even with wrong line numbers), SEARCH/REPLACE blocks, V4A patches, and JSON tool-call edits — to a tree of text files, to the specification in the kit's SPEC.md. It finds the lines an edit names at the first of three matching tiers (exact, trailing whitespace, full whitespace), and writes every change or none. Node 22, standard library only. Run as `node main.ts [options] [PATCH]`.

Entry for make.fun. Referral code: 38m33ybw
