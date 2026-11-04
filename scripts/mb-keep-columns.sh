#!/bin/bash
# Called by tar for each table as the MusicBrainz dump streams past. Saves only the columns
# import-musicbrainz.mjs reads, so the tables fit on a GitHub runner's disk.
# Usage: tar -xjf - --to-command="scripts/mb-keep-columns.sh <output folder>" mbdump/artist mbdump/track ...
set -euo pipefail
table="$(basename "$TAR_FILENAME")"
case "$table" in
  artist) columns=1-3 ;;               # id, gid, name
  artist_credit_name) columns=1,3 ;;   # artist_credit, artist
  recording) columns=1-4 ;;            # id, gid, name, artist_credit
  track) columns=1-4 ;;                # id, gid, recording, medium
  medium) columns=1-2 ;;               # id, release
  release_country) columns=1,3 ;;      # release, date_year
  release_unknown_country) columns=1-2 ;; # release, date_year
  l_recording_url) columns=1,3-4 ;;    # id, entity0, entity1
  url) columns=1,3 ;;                  # id, url
  *) cat > /dev/null; exit 0 ;;
esac
cut -f"$columns" > "$1/$table"
