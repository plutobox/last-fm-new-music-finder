#!/usr/bin/env bash
# Publishes a gh-pages working tree as one commit with no parent and force-pushes it over the branch, so gh-pages only
# ever holds the current files and never builds up history of the large data files.
# Usage: scripts/publish-pages.sh <pages dir> <commit message>
#
# Safe only because every workflow that writes gh-pages is in the gh-pages-write concurrency group and starts from a
# fresh clone of it: no two writers overlap, so the force-push can't drop another run's files.
set -euo pipefail
dir=$1
message=$2
cd "$dir"
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git add -A
if git rev-parse -q --verify HEAD >/dev/null && git diff --cached --quiet HEAD; then
  echo "No changes to publish"
  exit 0
fi
commit=$(git commit-tree "$(git write-tree)" -m "$message")
git push --force origin "$commit:refs/heads/gh-pages"
echo "Published $commit as the only commit on gh-pages"
