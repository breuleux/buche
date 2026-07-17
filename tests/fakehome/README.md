# Fake home

This directory is a throwaway working directory used by `tests/full.test.ts`.
Each full-run playbook is executed with a fresh copy of this directory as its
current working directory, so commands like `ls README.md` have something to
list.
