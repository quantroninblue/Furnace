#!/bin/sh
# macOS command sandbox for agent commands (Auto permission mode); the counterpart of
# ai-gui-sandbox.c, with the same arguments. Seatbelt (sandbox-exec) limits filesystem
# writes to the --write paths plus the per-user cache folder; reads and execution stay
# allowed. Unless --allow-network is given, IP networking is denied (Unix sockets stay
# allowed, like the Linux helper). Usage:
#   ai-gui-sandbox [--write PATH]... [--allow-network] -- COMMAND [ARG]...
#   ai-gui-sandbox --probe
FAIL=125
SANDBOX_EXEC=/usr/bin/sandbox-exec

fail() { echo "ai-gui-sandbox: $1" >&2; exit $FAIL; }

# Seatbelt matches resolved paths (/tmp is /private/tmp, $TMPDIR is under /private/var).
resolve() {
    if [ -d "$1" ]; then (cd -P -- "$1" 2>/dev/null && pwd -P)
    elif [ -e "$1" ]; then dir=$(cd -P -- "$(dirname -- "$1")" 2>/dev/null && pwd -P) && printf '%s/%s\n' "${dir%/}" "$(basename -- "$1")"
    fi
}
# An SBPL string literal: escape backslashes and double quotes.
quote() { printf '"%s"' "$(printf '%s' "$1" | sed 's/[\\"]/\\&/g')"; }

probe=0 network=0 writes=''
while [ $# -gt 0 ]; do
    case $1 in
        --probe) probe=1 ;;
        --allow-network) network=1 ;;
        --write) [ $# -ge 2 ] || fail 'invalid arguments'
            real=$(resolve "$2")  # Optional paths may be absent.
            [ -n "$real" ] && writes="$writes (subpath $(quote "$real"))"
            shift ;;
        --) shift; [ $# -gt 0 ] || fail 'missing command'; break ;;
        *) fail 'invalid arguments' ;;
    esac
    shift
done
[ $probe = 1 ] || [ $# -gt 0 ] || fail 'missing command'
[ -x $SANDBOX_EXEC ] || fail 'sandbox-exec is unavailable'

cache=$(resolve "$(getconf DARWIN_USER_CACHE_DIR 2>/dev/null)")
[ -n "$cache" ] && writes="$writes (subpath $(quote "$cache"))"
profile="(version 1)
(allow default)
(deny file-write*)
(allow file-write* (literal \"/dev/null\") (literal \"/dev/zero\") (literal \"/dev/tty\") (literal \"/dev/dtracehelper\")
    (regex #\"^/dev/ttys[0-9]+$\") (regex #\"^/dev/fd/\")$writes)"
[ $network = 1 ] || profile="$profile
(deny network*)
(allow network* (remote unix-socket))"

if [ $probe = 1 ]; then
    # Prove enforcement, not just syntax: a write outside the allowed paths must fail.
    target=$(mktemp -d "${TMPDIR:-/tmp}/ai-gui-sandbox-probe.XXXXXX") || fail 'mktemp failed'
    $SANDBOX_EXEC -p "$profile" /usr/bin/true || { rmdir "$target"; fail 'cannot apply sandbox profile'; }
    $SANDBOX_EXEC -p "$profile" /bin/sh -c ': > "$1/probe"' sh "$target" 2>/dev/null
    written=$?
    rm -rf "$target"
    [ $written != 0 ] || fail 'sandbox profile did not block writes'
    echo "ok seatbelt network=$([ $network = 1 ] && echo allowed || echo denied)"
    exit 0
fi
exec $SANDBOX_EXEC -p "$profile" "$@"
