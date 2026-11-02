# Fleet agent contact task runners

Each agent's QryptChat responder runs with that agent's Linux UID. Normal messages stay in chat
mode; authenticated instructions from Anthony enter that user's `agent-llm <agent> full` runner.
Task state stays in the agent's home and results return to the originating QryptChat conversation.

Each agent has a separately scoped group.call worker key, private phone settings, and an email
poller running under that agent's UID. Inbox pollers check every 30 seconds and baseline the
current inbox on first run, so old mail is not queued. Email actions require the trusted Anthony
DMARC verdict; the shared claim directory prevents forwarded copies from triggering duplicate
work. Mailbox credentials, QryptChat sessions, model logins, and task state stay in their owner's
home.

On dev2, deploy the CLI package and its production dependencies to `/opt/riotcoder-cli`, give each
ready agent a private `agent-llm.json`, QryptChat session, model login, and one-account
`mail.json`, then run `bash dev2/agents/install-agent-runners.sh` as root. The installer grants
the non-admin Fleet agent group read access to the CLI and installs a mail timer for every ready
account. An agent missing its own credentials is reported and skipped; the installer never borrows
Anthony's or another agent's login.
