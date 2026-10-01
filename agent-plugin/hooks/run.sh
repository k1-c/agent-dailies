#!/bin/sh
# Runs `agent-dailies hook <event>` with the hook input on stdin.
#
# It stays out of the way when agent-dailies is not installed, and keeps the
# Bash hook cheap: most commands do not open anything, so they pass without
# starting Node at all.

command -v agent-dailies >/dev/null 2>&1 || exit 0

event="$1"
input="$(cat)"

if [ "$event" = "pre-tool-use" ]; then
	case "$input" in
		*xdg-open*|*"gio open"*|*open\ *|*eog\ *|*feh\ *|*sxiv*|*imv\ *|*loupe*|*gwenview*|*ristretto*|*display\ *|*mpv\ *|*vlc\ *|*totem*|*celluloid*|*ffplay*|*firefox*|*chrom*|*brave*|*edge*) ;;
		*) exit 0 ;;
	esac
fi

printf '%s' "$input" | exec agent-dailies hook "$event"
