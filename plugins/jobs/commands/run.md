---
description: Start, stop, resume or inspect an apply run — in the foreground or in the background.
allowed-tools: Bash(jobhunt:*), Read
---

## Task

Manage apply runs. A run is the queue at the moment it started, and a record
on disk of where each job got to, so it survives a stop, a crash or a reboot.

```bash
jobhunt run start --dry-run --detach      # background dry run; prints the run id and log
jobhunt run start --detach                # background live run (show the queue first — /jobs:apply)
jobhunt run list                          # every run: id, status, profile, done/total
jobhunt run show [id]                     # one run, job by job (default: the newest for the profile)
jobhunt run stop [id]                     # stop it; see below
jobhunt run resume [id] [--detach]        # continue a stopped or crashed run
jobhunt run restart [id] [--detach]       # stop it if it is running, then resume
```

`$ARGUMENTS` is passed through: `/jobs:run show`, `/jobs:run stop 20260924-073722-d96b`.

## What stop and resume do

- **Stop** asks the worker to end between jobs. A form that is not yet
  submitted is abandoned unsubmitted; one waiting for a security code is
  abandoned too (without the code nothing was sent); one already past its
  final submit is finished first. The browser is closed either way.
- **Crash** (killed, rebooted): the next `run list`, `show` or `resume` notices
  the dead process and marks the run `crashed`. A job that had clicked its
  final submit becomes `unverified` and goes on the never-twice list; a job
  that was filling or waiting for a code is redone.
- **Resume** keeps everything done in that run, redoes the job that was
  interrupted from scratch (the form and the code are gone), and skips
  anything applied to since from another profile. The history records which
  jobs were carried over, redone and skipped.

Starting a live run is still a submit: the rules in /jobs:apply apply.
