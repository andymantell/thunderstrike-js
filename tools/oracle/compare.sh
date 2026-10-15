#!/bin/sh
# Run the port and the original with the same key presses and compare them frame by frame.
# usage: tools/oracle/compare.sh frames craft [--cheat=N] [--full] [--clear=N] [--mouse] [--pictures=N]
set -e
here=$(cd "$(dirname "$0")" && pwd)
out=${ORACLE_OUT:-$here/out}
py=${PYTHON:-python3}
mkdir -p "$out"
frames=$1; craft=$2; shift 2
node "$here/port.mjs" "$frames" "$craft" "$out/port.json" "$@"
clear=0; pictures=0
for a in "$@"; do
  case $a in --clear=*) clear=${a#--clear=};; --pictures=*) pictures=${a#--pictures=};; esac
done
$py "$here/orig.py" "$out/port.keys.json" "$craft" "$out/orig.json" "$clear" "$pictures"
status=0
$py "$here/compare.py" "$out/orig.json" "$out/port.json" || status=1
if [ "$pictures" != 0 ]; then $py "$here/pictures.py" "$out/orig.json" "$out/port.json" | grep -v ' ok$' || true; fi
exit $status
