# data

Data files that commands read at run time.

## disposable-email-domains.txt

Used by `email-cleaner` to reject throwaway addresses.

- Source: [disposable-email-domains/disposable-email-domains](https://github.com/disposable-email-domains/disposable-email-domains),
  `disposable_email_blocklist.conf` at commit
  `68e923683dc590073414ea25409333dfc0e0b245`, fetched 2026-09-24.
- Licence: [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/).
  The maintainers dedicated the list to the public domain; no attribution is
  required, and this note is here so the provenance is not lost.
- The file is the upstream list verbatim with a short `#` header added. Lines
  starting with `#` are ignored.

To refresh it, replace everything below the header with the current upstream
file and update the commit in both places. To add domains without editing it,
pass `email-cleaner --disposable-list FILE` (same format).
