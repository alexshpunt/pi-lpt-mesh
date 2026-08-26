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

### Workspace tree isolation

Every hello handshake must include a logical workspace position derived from the session `cwd`. In Git, the repository's common Git directory identifies the project; the main worktree is `root`, linked worktrees are sibling branches, and folders below a worktree are nested positions. Outside Git, canonical filesystem ancestry defines the tree.

Normal peer discovery and delivery allow peers on the same branch, including ancestors and descendants. Sibling branches and different projects are hidden and blocked by default. A shared non-default room is a deliberate exception: it makes peers visible, and allows delivery only when that selected room is shared. The `default` room never bypasses isolation.

A blocked target returns the generic `peer_not_found` result. Workspace paths remain broker-internal and are not included in peer snapshots. Clients without workspace metadata are rejected with `workspace_required`. `mesh_status({ all: true })` is the sole diagnostic visibility bypass; a room argument narrows normal results.
