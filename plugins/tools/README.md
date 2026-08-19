# tools

Install and manage the `cli-tools` command set.

`/tools:install` puts every command on `PATH` and wires up the moshcode pit
aliases. `/tools:list` says which checkout they run from and what actually
landed.

## Install

```bash
moshcode plugin marketplace add profullstack/cli-tools
moshcode plugin install tools@cli-tools
```

Or install the commands directly, without the plugin:

```bash
curl -fsSL https://raw.githubusercontent.com/profullstack/cli-tools/master/install.sh | sh
cli-tools aliases --install
```

## The thing worth knowing

The installed commands are **symlinks into a working tree**, not a copied build.
Whatever branch the checkout sits on is the code that runs, so a merged PR does
not update the installed command and a checkout parked on an old branch produces
stale output with no warning. `cli-tools where` names the checkout; `cli-tools
update` pulls and relinks it, refusing to move a dirty or diverged tree rather
than discarding work.

The commands are real executables rather than shell functions because a file
works from every caller — an interactive shell, `zsh -c`, a systemd unit, a CI
step — without anything having been sourced first. The pit aliases this installs
are a shorter word for a longer invocation, never what makes a command
reachable, and none of them shares a name with a command: a function beats
`PATH`, so a wrapper of the same name would silently shadow the file.
