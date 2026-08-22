# Security policy

## Supported scope

Security updates target the versions listed in `docs/SUPPORT.md`. Pre-release builds and unverified host versions receive best-effort fixes without compatibility claims.

## Local threat model

Agent Coach is a single-user local application. It defends against accidental exposure, malicious web origins, unauthenticated localhost requests, memory-content injection, configuration corruption, and cross-project data leakage.

It cannot protect data from a malicious process already running with the same OS user privileges. Host Agent permissions and sandboxes remain the security authority; coaching Hooks are not a complete enforcement boundary.

## Security invariants

- Loopback-only by default, bearer authentication on every API, no secret in discovery.
- Dashboard uses one-time bootstrap, same-site session, CSRF, Host/Origin checks and CSP.
- Memory content is untrusted text; category, rank, namespace or retrieval score never grants instruction authority.
- Public fixtures contain no real user data, credentials or machine paths.
- Integration writes are preview-first, atomic, read back, ownership-scoped and rollback-capable.
- Provider network access is disabled until explicit consent.

## Reporting

Do not open a public issue containing a working exploit, private prompt, credential, memory database or user path. Use GitHub's private vulnerability reporting for the repository once enabled. Until then, contact the repository owner through the private contact method listed in the GitHub profile and include only the minimum reproduction needed.
