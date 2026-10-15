# Keeping up with MailCheap

MailCru is a fork of [MailCheap](https://github.com/marclou/mailcheap). Its fixes and features keep coming, so
MailCru merges them in and re-applies its branding with `scripts/rebrand.mjs`.

## Remotes

```bash
git remote -v
# origin    https://github.com/akash-yadav-dev/mailcru.git   (this fork)
# upstream  https://github.com/marclou/mailcheap.git          (the original)
```

On a fresh clone, add upstream once: `git remote add upstream https://github.com/marclou/mailcheap.git`.

## Merging upstream

```bash
git checkout main && git pull
git checkout -b sync/upstream-$(date +%Y-%m-%d)
git fetch upstream
git merge upstream/main
```

Conflicts are mostly lines where upstream changed something and MailCru only changed the name. In those, take
upstream's line: the next step rebrands it. Keep MailCru's side only where MailCru changed real behavior.

```bash
npm run rebrand          # MailCheap → MailCru across the code, renames files
npm run rebrand:check    # fails if anything still says mailcheap
npm install
npm test && npm run lint && npm run build
```

Then commit, push the branch and open a pull request into `main`.

## Don't

- Edit `LICENSE`. It's the AGPL's text and stays verbatim.
- Remove the credit to MailCheap and Marc Lou in `README.md` and `NOTICE.md`. `scripts/rebrand.mjs` leaves them alone
  on purpose (`PROTECTED`).
- Point `SOURCE_URL` (`lib/site.js`) anywhere but this repository's public source while MailCru runs for other
  people: the AGPL requires it (section 13).
- Copy MailCheap's logo, screenshots or marketing site: the license covers the code, not the brand.

When MailCru changes something upstream doesn't have, add a line to the list in `NOTICE.md`.
