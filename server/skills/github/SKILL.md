---
name: github
description: GitHub CLI operations (PRs, issues, actions, releases).
requires_bins: gh
---

# GitHub CLI Skill

Use the `gh` CLI tool (via `run_command`) for GitHub operations.

## Common Operations

### Pull Requests
```bash
gh pr list                           # list open PRs
gh pr view 123                       # view PR details
gh pr create --title "Fix bug" --body "..."  # create PR
gh pr merge 123                      # merge PR
gh pr checks 123                     # view CI status
```

### Issues
```bash
gh issue list                        # list open issues
gh issue view 42                     # view issue
gh issue create --title "Bug" --body "..."  # create issue
gh issue close 42                    # close issue
```

### Actions / CI
```bash
gh run list                          # list recent workflow runs
gh run view 12345                    # view run details
gh run view 12345 --log-failed       # view failed step logs
gh run rerun 12345                   # re-run a failed run
```

### Releases
```bash
gh release list                      # list releases
gh release create v1.0.0 --title "v1.0.0" --notes "..."  # create release
```

### API (advanced)
```bash
gh api repos/{owner}/{repo}/pulls/123/comments --jq '.[].body'
gh api graphql -f query='{ viewer { login } }'
```

## Tips
- `gh` must be authenticated (`gh auth login`)
- Use `--json` flag for machine-readable output: `gh pr list --json number,title,state`
- Use `--jq` for filtering: `gh pr list --json title --jq '.[].title'`
