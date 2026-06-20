# Security Policy

## Reporting a Vulnerability

If you believe you've found a security vulnerability in m1n3 — either in
the Move contracts under `contracts/`, the Rust services under
`stratum-server/`, `miner-sidecar/`, `trustless-keeper/`, or the dapp
under `web/` — please **do not** open a public GitHub issue.

Instead, open a private vulnerability report from the
[Security tab](https://github.com/f4u57ox/m1n3-protocol/security/advisories/new)
of this repository. GitHub Security Advisories give us a private channel
to triage and coordinate disclosure before details become public.

If GitHub's advisory flow isn't available, send a short summary to the
maintainer via the contact email listed on the GitHub profile of the
repo owner.

## Scope

In scope:
- The on-chain m1n3 Move package (`m1n3_v4`).
- The off-chain stratum server, miner sidecar, trustless keeper, and
  Sui client.
- The dapp routes under `web/app/` that touch wallet signatures or read
  protocol state.

Out of scope (third-party dependencies — please report upstream):
- The DeepBookV3 contracts and SDK.
- The Hashi bridge, Hashi MPC committee, and `hashi::deposit::deposit`.
- The Sui framework itself.
- OpenZeppelin's `contracts-sui` libraries.

## Response

We'll acknowledge reports within 72 hours and aim to provide a
remediation timeline within seven days. Coordinated disclosure dates
are negotiated case by case.

## Hall of Fame

Reporters who responsibly disclose will be acknowledged here (with
permission) after the issue is patched.
