# Team load canvas

A Copilot app canvas (`tinyclips-team-load`) that shows what each teammate and the Copilot coding agent is working on, so you can hand out new work to whoever has room.

## What it shows

- **Who's on what**: one row per tracked person. The row shows a load meter (open assigned issues + authored PRs + review requests, with a limit marker), a status label (Free / Has room / Busy / At limit / N over limit), and their most recent item. Expand a row to see every item.
- **Needs an owner**: open, unassigned issues in the tracked repos.
- Clicking any issue or PR opens it inside the canvas. You get the title, state, labels, assignees, the rendered body and the latest comments, plus Back and Open on GitHub.

## Actions (real GitHub writes)

| Action | How |
| --- | --- |
| Assign to a person | `gh issue edit N --repo o/r --add-assignee <login>`, re-read to verify |
| Assign to Copilot | `gh issue edit N --repo o/r --add-assignee @copilot` (starts the coding agent) |
| Start a session myself | assigns you, then `session.send({ prompt })` to the hosting conversation; rolls back the assignment if sending fails |
| Undo | `--remove-assignee` for the same login |

Before writing, it checks for conflicts: the issue is already assigned, closed, or a PR. After each write it refreshes.

## Data

Everything is fetched live with the GitHub CLI (`gh`, must be signed in). Repos are fetched through GraphQL with pagination, at most 3 concurrent requests, and one retry for transient read errors. Profiles are cached and coalesced. A failing repo shows a warning without breaking the rest of the view. Auto-refresh runs every `refreshSeconds` (minimum 60) while the canvas is visible.

## Tracking

Use the **people** and **repos** pickers in the header to choose what's tracked. Defaults come from `config.json`. Your selection is saved to:

```
$COPILOT_HOME/extension-data/tinyclips-team-load/tracking.json   (default ~/.copilot/...)
```

Delete that file to reset to the defaults.

## Security

The canvas is served from a loopback server with a per-launch nonce, a host/origin check and a strict CSP (no inline script or style). Issue and comment HTML is sanitized client-side against an allowlist before rendering.

## Development

```bash
node --test .github/extensions/tinyclips-team-load/tests/
```

Tests mock `gh`; they never touch GitHub.
