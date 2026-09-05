# mail

The inbox from the terminal, for more than one account.

`/mail:inbox` lists, searches and reads over IMAP, and marks, files or deletes.
`/mail:send` replies in the original's thread or sends a new message, over the
account's SMTP with Resend as the fallback, or files it as a draft.

## Install

```bash
moshcode plugin marketplace add profullstack/cli-tools
moshcode plugin install mail@cli-tools
```

Or install the command directly, without the plugin:

```bash
curl -fsSL https://raw.githubusercontent.com/profullstack/cli-tools/master/install.sh | sh
mail accounts pull           # accounts from the cli-tools-mail team vault
cli-tools config pull        # the Resend key, for the fallback
```

## The thing worth knowing

**Two accounts, two rule sets.** A business address on its own domain can
send through Resend when SMTP is down, because the team has verified the
domain there. A Gmail address cannot: gmail.com is not anyone's to verify, so
that account reads and sends only with an App Password, and `mail` says so
rather than trying Resend and reporting a 403.

**A reply threads.** `mail reply` carries `In-Reply-To` and `References`,
answers the Reply-To when one was set, and quotes the original underneath —
so the other side's client files it under the same conversation, which is the
difference between a reply and a new message that happens to share a subject.

**Nothing here names a person.** Accounts live in
`~/.config/cli-tools/mail.json` (0600) or in the vault as
`MAIL_<NAME>_EMAIL` / `_PROVIDER` / `_PASSWORD`; the environment's
`MAIL_<NAME>_PASSWORD` wins over the stored one, and `mail accounts` shows
which source is in effect without ever printing a password.
