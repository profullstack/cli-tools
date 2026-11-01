#!/usr/bin/env python3
"""agent-mail-trusted: which mail in an agent's mailbox (riotcoder@, cha0spunk@profullstack.com) is really from Anthony.

Lists the newest INBOX messages (default 40) as JSON lines: uid, date, from, subject,
messageId, answered, trusted, why. A message is trusted only when the TOPMOST
ARC-Authentication-Results header (the one Forward Email's MX prepends on arrival;
anything below it can be written by the sender) says dmarc=pass for the From domain,
and the From address is one of Anthony's: ettinger@gmail.com or anthony@profullstack.com.
Gmail and Forward Email both refuse a From the sender's login does not own, so a
DMARC pass on those addresses means Anthony sent it.

  agent-mail-trusted -a riotcoder|cha0spunk [--limit N] [--unanswered]   (--unanswered skips answered and flagged)
"""
import json, re, subprocess, sys

ANTHONY = {"ettinger@gmail.com", "anthony@profullstack.com"}

def run(*args):
    return subprocess.run(["mail", *args], capture_output=True, text=True, timeout=120).stdout

def addr(s):
    m = re.search(r"<([^>]+)>", s or "")
    return (m.group(1) if m else (s or "")).strip().lower()

def verdict(uid):
    raw = run("read", str(uid), "-a", ACCOUNT, "--raw", "--keep-unread")
    head = raw.split("\r\n\r\n", 1)[0].split("\n\n", 1)[0]
    # Unfold header lines, keep order.
    headers = re.sub(r"\r?\n[ \t]+", " ", head).splitlines()
    arc = next((h for h in headers if h.lower().startswith("arc-authentication-results:")), "")
    frm = addr(next((h.split(":", 1)[1] for h in headers if h.lower().startswith("from:")), ""))
    global LAST_TO
    LAST_TO = sorted({a.lower() for h in headers if h.lower().startswith(("to:", "cc:")) for a in re.findall(r"[\w.+-]+@[\w.-]+", h.split(":", 1)[1])})
    if "mx1.forwardemail.net" not in arc and "mx2.forwardemail.net" not in arc:
        return False, frm, "no Forward Email verdict on top"
    m = re.search(r"dmarc=(\w+)[^;]*header\.from=([\w.-]+)", arc)
    if not m or m.group(1) != "pass":
        return False, frm, f"dmarc {m.group(1) if m else 'missing'}"
    if frm.split("@")[-1] != m.group(2).lower():
        return False, frm, "dmarc passed for another domain"
    if frm not in ANTHONY:
        return False, frm, "not from Anthony"
    return True, frm, "dmarc pass, Anthony's address"

ACCOUNT = sys.argv[sys.argv.index("-a") + 1] if "-a" in sys.argv else "riotcoder"
LAST_TO = []

def main():
    limit = sys.argv[sys.argv.index("--limit") + 1] if "--limit" in sys.argv else "40"
    msgs = json.loads(run("ls", "-a", ACCOUNT, "--limit", limit, "--json") or "[]")
    for m in msgs:
        # Flagged = handled some other way (the old Gmail-reply path); answered = riotcoder replied.
        if "--unanswered" in sys.argv and (m.get("answered") or m.get("flagged")):
            continue
        ok, frm, why = verdict(m["uid"])
        print(json.dumps({"uid": m["uid"], "date": m["date"], "from": frm, "subject": m["subject"], "messageId": m.get("messageId"), "to": LAST_TO, "answered": m.get("answered"), "trusted": ok, "why": why}))

main()
