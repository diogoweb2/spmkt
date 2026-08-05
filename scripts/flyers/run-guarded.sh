#!/bin/zsh
# Runs the flyer import once per day. launchd fires this at 07:00 and again at
# 10:00; the 10:00 firing is a retry that no-ops if the 07:00 run succeeded.
set -u

NODE=/Users/diogolopes/.local/share/fnm/node-versions/v24.12.0/installation/bin/node
SCRIPT=/Users/diogolopes/dev/Spmkt/scripts/flyers/run.mjs
STAMP=/Users/diogolopes/Library/Logs/spmkt-flyers-last-success

today=$(date +%F)

if [[ -f "$STAMP" && "$(cat "$STAMP")" == "$today" ]]; then
  echo "[$(date '+%F %T')] flyers: already succeeded today ($today), skipping"
  exit 0
fi

echo "[$(date '+%F %T')] flyers: starting run"
"$NODE" "$SCRIPT" --upcoming
status=$?

if [[ $status -eq 0 ]]; then
  echo "$today" > "$STAMP"
  echo "[$(date '+%F %T')] flyers: success"
else
  echo "[$(date '+%F %T')] flyers: failed (exit $status), will retry at next slot"
fi

exit $status
