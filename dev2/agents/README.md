# RiotCoder contact task runner

`qc-agent-responder.py` handles QryptChat for the Linux user who owns the QryptChat session. It
keeps ordinary replies in chat mode and queues authenticated Anthony instructions for
`agent-llm riotcoder full`. The worker runs with RiotCoder's UID, writes private task state under
his home, and sends its result to the originating QryptChat conversation.

The group.call phone worker sends trusted caller requests to the same queue. `agent-mail-poll`
polls only RiotCoder's mailbox; before work, the agent checks the Forward Email DMARC verdict and
claims the message, then replies from RiotCoder's own SMTP settings. Do not place RiotCoder's mail
configuration or task state in Anthony's home.

On dev2, deploy the CLI package and its production dependencies to `/opt/riotcoder-cli`, provision
`/home/riotcoder/.config/cli-tools/mail.json` with only the RiotCoder account, then run
`bash dev2/agents/install-riotcoder.sh` as root. The installer grants RiotCoder's group read
access to the deployed CLI and places the responder and mail tools in the correct homes.
The mail poller runs as UID RiotCoder.
