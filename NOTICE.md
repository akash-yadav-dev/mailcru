# Notice

MailCru is a modified version of **MailCheap**, Copyright (C) 2026 Marc Lou,
<https://github.com/marclou/mailcheap>, released under the GNU Affero General Public License v3.0.

MailCru, including these modifications, is Copyright (C) 2026 Akash Yadav and is distributed under the
same license, GNU AGPL-3.0-only. The full text is in [LICENSE](LICENSE), kept unchanged.

## Modifications

This notice satisfies section 5(a) of the AGPL: the work has been modified. Changes from upstream, starting
2026-10-15:

- **Rebrand.** The product name MailCheap is now MailCru, the domain mailcheap.ai is now mailcru.com, and
  identifiers change to match: `MAILCHEAP_CLOUD` is `MAILCRU_CLOUD`, `MAILCHEAP_API_KEY` is `MAILCRU_API_KEY`,
  Stripe lookup keys are `mailcru_<plan>_<interval>`, `LogoMailcheap` is `LogoMailcru`. `scripts/rebrand.mjs`
  makes these changes and can be re-run after every merge from upstream. Internal key-derivation labels of
  signed links (`mailcheap-unsubscribe-v1` and the like) keep upstream's names: they're never shown, and
  renaming them would change every link signature.
- **Logo.** MailCheap's paper-plane mark is replaced by MailCru's own envelope mark (`components/LogoMailcru.jsx`,
  `app/icon.svg`, `app/apple-icon.png`, `public/favicon.ico`).
- **Source link.** The "Source code" link (`SOURCE_URL` in `lib/site.js`) points at this fork,
  <https://github.com/akash-yadav-dev/mailcru>, so everyone who uses MailCru over a network can get its
  source, as section 13 of the AGPL requires.

Every later change is in this repository's git history.

## Names and marks

The AGPL grants rights to the code, not to names or logos. "MailCheap", mailcheap.ai and the MailCheap logo
belong to their owner and aren't used as MailCru's brand; the name MailCheap appears only to credit the
original project.

## Third-party material

- Geist fonts: SIL Open Font License 1.1, see `assets/fonts/OFL.txt`.
- Brand marks from Simple Icons (CC0), see `lib/social.js`.
- npm dependencies keep their own licenses, listed in `package-lock.json` and each package's files.
