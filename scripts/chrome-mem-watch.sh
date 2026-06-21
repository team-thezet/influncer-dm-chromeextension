#!/bin/bash
# chrome-mem-watch.sh — catch a runaway Chrome renderer BEFORE it hits multi-GB.
#
# Read-only: it only samples `ps`. When any Chrome renderer's RSS crosses the
# threshold it logs [time | RSS | CPU | uptime | PID | instance] and fires one
# macOS notification per PID. "instance" is read from --user-data-dir, so you can
# tell a daily-browser tab from an agent/Playwright profile at a glance.
#
# Usage:   bash chrome-mem-watch.sh [THRESHOLD_MB] [INTERVAL_SEC]
# Example: bash chrome-mem-watch.sh 1200 20      # alert > 1.2GB, sample every 20s
# Stop:    Ctrl-C  (or: pkill -f chrome-mem-watch.sh)
#
# When it alerts: open Chrome's own Task Manager (Shift+Esc) to see WHICH tab the
# PID is, then that tab's DevTools > Memory > heap snapshot to see the CAUSE
# (detached DOM nodes / huge arrays / leaked listeners).

THRESH_MB="${1:-1200}"
INTERVAL="${2:-20}"
LOG="${CHROME_WATCH_LOG:-$HOME/chrome-mem-watch.log}"
NOTIFIED=" "

printf 'watching Chrome renderers > %sMB every %ss → %s  (Ctrl-C to stop)\n' \
  "$THRESH_MB" "$INTERVAL" "$LOG"
printf '%s  watch started (threshold %sMB)\n' "$(date '+%F %T')" "$THRESH_MB" >> "$LOG"

while true; do
  ts="$(date '+%F %T')"
  while IFS='|' read -r pid rssmb cpu et inst; do
    [ -z "$pid" ] && continue
    line="$ts | ${rssmb}MB | CPU ${cpu}% | up ${et} | PID ${pid} | inst=${inst}"
    printf '%s\n' "$line" | tee -a "$LOG"
    case "$NOTIFIED" in
      *" $pid "*) : ;;  # already alerted for this PID
      *)
        osascript -e "display notification \"PID $pid ${rssmb}MB ($inst) — Shift+Esc로 어느 탭인지 확인\" with title \"⚠️ Chrome 메모리 ${rssmb}MB\"" >/dev/null 2>&1
        NOTIFIED="$NOTIFIED$pid "
        ;;
    esac
  done < <(ps -axww -o pid=,rss=,pcpu=,etime=,command= | awk -v th="$THRESH_MB" '
    /Google Chrome/ && /--type=renderer/ {
      rss = $2 / 1024
      if (rss <= th) next
      udd = "default"
      for (i = 5; i <= NF; i++) {
        if ($i ~ /^--user-data-dir=/) { n = split($i, a, "/"); udd = a[n] }
      }
      printf "%d|%.0f|%s|%s|%s\n", $1, rss, $3, $4, udd
    }')
  sleep "$INTERVAL"
done
