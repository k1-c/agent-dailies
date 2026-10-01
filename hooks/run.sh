#!/bin/sh
# Runs `agent-dailies hook <event>` from this plugin, with the hook input on stdin.
#
# Nothing to install: the plugin carries the code and Node runs it. At session
# start the hook also puts the plugin's bin/ on the PATH of the agent's shell
# (through $CLAUDE_ENV_FILE), so the agent can type `agent-dailies show …`.
# The Bash hook stays cheap: most commands do not open anything, and they pass
# without starting Node at all.

root="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
cli="$root/bin/agent-dailies"
event="$1"
input="$(cat)"

if [ "$event" = "session-start" ] && [ -n "$CLAUDE_ENV_FILE" ]; then
	printf 'export PATH="%s/bin:$PATH"\n' "$root" >>"$CLAUDE_ENV_FILE"
fi

command -v node >/dev/null 2>&1 || {
	[ "$event" = "session-start" ] && echo "agent-dailies (a review page for what you make) is installed but needs Node.js 22.6+, and node is not on PATH; tell the user if they expect it."
	exit 0
}

if [ "$event" = "pre-tool-use" ]; then
	case "$input" in
		*xdg-open*|*"gio open"*|*open\ *|*eog\ *|*feh\ *|*sxiv*|*imv\ *|*loupe*|*gwenview*|*ristretto*|*display\ *|*mpv\ *|*vlc\ *|*totem*|*celluloid*|*ffplay*|*firefox*|*chrom*|*brave*|*edge*) ;;
		*) exit 0 ;;
	esac
fi

printf '%s' "$input" | exec sh "$cli" hook "$event"
