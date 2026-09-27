# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem.

- Preferred: use GitHub's private vulnerability reporting on this repository
  (Security → Report a vulnerability). It opens a private advisory thread
  with the maintainers.
- Or email **contact@ficus.sh** with "security" in the subject.

Include what you found, how to reproduce it, and the version or commit you
tested against. You will get an acknowledgement within three business days
and a fix or a timeline within fourteen.

## Scope

This repository is Ficus Core: the self-hosted server, worker, CLI, web app and
setup toolkit. Reports about the hosted Ficus Cloud service (ficus.sh) are
welcome at the same address; please say which one you mean.

## Supported versions

The `main` branch and the most recent tagged release receive security fixes.
Self-hosted installs should track a tagged release and update when one ships.

## Disclosure

We coordinate disclosure with the reporter and publish a GitHub security
advisory once a fix is available. Please give us a reasonable window before
publishing details yourself.
