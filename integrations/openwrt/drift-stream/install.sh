#!/bin/sh
# Run from the uploaded dist/ directory. Refuse unknown init scripts; preserve rollback.
set -eu
cd "$(dirname "$0")"
init=/etc/init.d/transmission
hook=/usr/libexec/drift-stream.procd
marker='[ ! -r /usr/libexec/drift-stream.procd ] || . /usr/libexec/drift-stream.procd'
test -f "$init"
test -x ./drift-stream
test -f ./drift-stream.procd
if ! grep -Fq "$marker" "$init"; then
    count=$(grep -c '^[[:space:]]*procd_close_instance[[:space:]]*$' "$init")
    test "$count" = 1 || { echo 'Unrecognized Transmission init script; refusing to patch' >&2; exit 1; }
    test ! -e "$init.before-drift-stream" || { echo 'Existing backup requires manual review' >&2; exit 1; }
    cp -p "$init" "$init.before-drift-stream"
    # Stage and syntax-check before replacing the init script atomically.
    awk -v marker="$marker" '{ print; if ($0 ~ /^[[:space:]]*procd_close_instance[[:space:]]*$/) print "\t" marker }' "$init" > "$init.drift-new"
    sh -n "$init.drift-new"
    chmod 755 "$init.drift-new"
    mv "$init.drift-new" "$init"
fi
mkdir -p /usr/libexec
cp ./drift-stream /usr/bin/drift-stream.new
chmod 755 /usr/bin/drift-stream.new
mv /usr/bin/drift-stream.new /usr/bin/drift-stream
cp ./drift-stream.procd "$hook.new"
chmod 644 "$hook.new"
mv "$hook.new" "$hook"
echo 'Installed. Restart Transmission when convenient to activate its companion instance.'
echo 'To disable: remove /usr/libexec/drift-stream.procd, then restart Transmission.'
