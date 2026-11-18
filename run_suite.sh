#!/bin/bash
# Full RTDB-mode regression suite (guards the sb_adapter dispatcher refactor).
cd ~/workspace/viking_server_rtdb
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY all_proxy ALL_PROXY
LOG=~/workspace/viking_server_rtdb/suite_run.log
: > "$LOG"
emu_up() { curl -s -o /dev/null "http://127.0.0.1:9000/.json?ns=demo-viking-default-rtdb"; }
start_emu() {
  nohup ~/workspace/tools/jre/bin/java -jar ~/.cache/firebase/emulators/firebase-database-emulator-v4.11.2.jar > ~/workspace/tools/rtdb-emu.log 2>&1 &
  for i in $(seq 1 30); do emu_up && return 0; sleep 1; done
  return 1
}
TOTAL_PASS=0; TOTAL_FAIL=0; FAILED_FILES=""
for f in test_local.js test_local2.js test_local3.js test_local4.js test_local5.js test_local6.js test_local7.js test_local8.js test_local9.js test_local10.js test_local11.js test_local12.js test_local13.js test_local14.js test_local15.js test_local16.js test_local17.js test_local18.js test_local19.js test_local20.js test_local21.js test_local22.js test_local23.js test_local24.js test_local25.js; do
  [ -f "$f" ] || continue
  emu_up || start_emu
  timeout 240 node "$f" > "/tmp/suite_$f.log" 2>&1
  line=$(grep -o "[0-9]* passed, [0-9]* failed" "/tmp/suite_$f.log" | tail -1)
  echo "$f: ${line:-NO RESULT (see /tmp/suite_$f.log)}" >> "$LOG"
  p=$(echo "$line" | grep -o "^[0-9]*"); fl=$(echo "$line" | grep -o "[0-9]*" | tail -1)
  TOTAL_PASS=$((TOTAL_PASS + ${p:-0})); TOTAL_FAIL=$((TOTAL_FAIL + ${fl:-0}))
  [ "${fl:-1}" != "0" ] && FAILED_FILES="$FAILED_FILES $f"
done
echo "SUITE TOTAL: $TOTAL_PASS passed, $TOTAL_FAIL failed; files with failures:${FAILED_FILES:- none}" >> "$LOG"
echo DONE >> "$LOG"
