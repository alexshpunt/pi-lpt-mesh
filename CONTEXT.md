# Mesh context

## Terms

### Alias

The single mesh identity used both to display and address an agent. A semantic agent alias has the form `<repo-name>-<root|branch_normalized>-<role>[-index]`.

### Main worktree

The primary worktree of a shared Git repository. Its alias worktree component is `root`.

### Linked worktree

An additional worktree of the same Git repository. Its alias worktree component is the normalised full branch name, or the worktree folder name when HEAD is detached.

### Role

The Herdr agent-definition launch key passed as `PI_SUBAGENT_AGENT`. A Pi session without one uses `agent`.

### Opaque alias

A generated identity such as `agent-eb9626` that identifies a connection but hides its repository, worktree, and role.
