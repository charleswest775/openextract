# Security Policy

## Reporting a vulnerability

If you believe you've found a security vulnerability in OpenExtract, **please do not open a public GitHub issue.** Instead, report it privately:

- **Preferred:** open a private [security advisory](https://github.com/charleswest775/openextract/security/advisories/new) on this repository. GitHub's private reporting lets us discuss fix and disclosure with you before anything becomes public.
- **Alternative:** email security@openextract.app with the details. Please include steps to reproduce, impact, and — if you have one — a suggested fix.

We aim to acknowledge reports within **72 hours** and to provide an initial assessment within **one week**. If your report leads to a fix, we'll credit you in the release notes unless you prefer to remain anonymous.

## Scope

OpenExtract is a desktop application that reads iPhone backup files created by Apple's own tools (iTunes, Finder, Apple Devices). The attack surface we care about:

### In scope

- **Code execution** from a malicious iPhone backup file that bypasses the application's sandbox or sidecar isolation.
- **Path-traversal or write-anywhere** issues via crafted filenames or attachment paths.
- **Parser bugs** that cause OOB reads, crashes, or memory corruption on malformed inputs.
- **Signature-verification bypasses** on installed releases (the installer is signed; if that signature can be spoofed or stripped in place, we want to know).
- **Dependency vulnerabilities** with a practical impact on OpenExtract users.
- **Supply-chain issues** — malicious code introduced into a released binary.

### Out of scope

- Vulnerabilities in Apple's backup format itself. If Apple's backup format leaks data in some way, that's an Apple issue — we report the data as the format contains it.
- Vulnerabilities in the iOS operating system or iTunes/Finder's backup creation. We are a reader, not the backup producer.
- Social-engineering or phishing attacks against the project's infrastructure that don't require a code change on our side.
- Reports generated from automated scanners without a real-world exploit scenario.
- Denial-of-service via deliberately malformed backup files (the tool can choose not to parse them).

## Threat model, explicitly

OpenExtract is a tool that runs on a user's own machine and reads backup data the user has on disk. Our security assumptions:

- **The user trusts the machine** they install OpenExtract on.
- **The backup is on the user's own storage** — we don't need to defend against a backup being served from an untrusted network source.
- **The user's OS enforces code-signing** — on macOS we rely on Gatekeeper + notarization; on Windows on SmartScreen + Authenticode.
- **No network trust is required** — OpenExtract does not phone home, does not auto-update silently, does not load remote code.

Where this matters: a crafted backup file on a user's disk that causes OpenExtract to execute arbitrary code **is in scope** — even though the user put the file there — because "I was given a backup to review" is a real scenario (investigators, legal use).

## Supported versions

We support the latest minor release. If you're on an older release and hit a security issue, upgrade first; if the issue reproduces on the latest release, report it.

| Version | Supported |
| --- | --- |
| 0.3.x (latest) | ✓ |
| Older versions | — |

## Disclosure policy

Our default is **coordinated disclosure**:

1. You report the issue privately.
2. We acknowledge and investigate.
3. We develop and test a fix.
4. We cut a patched release.
5. We publish an advisory crediting you, after the patched release is available.

If the issue is being actively exploited in the wild, we'll prioritize getting a fix out and may disclose sooner.

## Responsible use

OpenExtract is designed for extracting data from your own iPhone backups, or from backups you have lawful authority to examine (e.g., under a court order, preservation letter, or explicit consent). Using this tool against a backup you are not authorized to examine is likely illegal where you are. That's outside our threat model and outside what we support.
