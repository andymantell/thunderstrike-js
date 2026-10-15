#!/bin/sh
# Run the port and the original with the same key presses and compare them frame by frame.
# usage: tools/oracle/compare.sh frames slot [--cheat=period] [--full] [--clear=period]
set -e
here=$(cd "$(dirname "$0")" && pwd)
out=${ORACLE_OUT:-$here/out}
mkdir -p "$out"
frames=$1; slot=$2; shift 2
node "$here/port.mjs" "$frames" "$slot" "$out/port.json" "$@"
clear=0
for a in "$@"; do case $a in --clear=*) clear=${a#--clear=};; esac; done
${PYTHON:-python3} "$here/orig.py" "$out/port.keys.json" "$slot" "$out/orig.json" "$clear"
${PYTHON:-python3} "$here/compare.py" "$out/orig.json" "$out/port.json"
