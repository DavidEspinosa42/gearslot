# 0006. Identity comes from the SSO gateway, not from this app

Status: Accepted

## Context

The data policy allows an opaque SSO subject and a display name, nothing else. Building login,
sessions and password or token handling inside a v1 booking app would add attack surface and personal
data for no benefit: the institution already runs SSO.

## Decision

The app trusts two request headers set by the institution's SSO gateway or reverse proxy:
`x-sso-subject` (validated as 1-128 printable ASCII characters) and `x-sso-display-name` (control
characters stripped, at most 100 characters). The gateway must strip these headers from outside
requests. A malformed subject is `401`, and it never falls through to the development identity. Outside
production, `DEV_USER_SUBJECT` and `DEV_USER_NAME` supply a fixed identity.

## Consequences

- No credentials, sessions or cookies are stored or issued by the app.
- Deploying without the gateway in front would let anyone claim any identity. The README and
  AGENTS.md say so, and production never reads the development identity.
- Replacing this with OIDC in the app is a roadmap item and only changes `identify()`.
