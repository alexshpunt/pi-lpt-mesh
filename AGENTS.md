# Agent instructions

## Requirements artifacts

Store each task's requirements artifacts in:

`.lpt/plans/<feature-name>/`

Keep the confirmed, evergreen requirements in `intention.md` and the chronological discovery record in `requirements-notes.md` within that directory.


## `CONTEXT.md` updates

Treat `CONTEXT.md` as a committed project contract. Whenever you update it, commit the change immediately, before making other changes. Do not leave `CONTEXT.md` modified or in an intermediate state in the worktree. Keep its contents consistent with the current implementation before handing work off or creating another commit.
