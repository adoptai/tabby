# Vulnerabilities founded

## Axios - Potential server-side request forgery (SSRF) - Critical


Affected by 16 CVEs: last detected 9 hours ago

New
Dependency
TL;DR

axios is affected by 16 vulnerabilities. To learn more about each one, consult the table below.The worst case impact for these vulnerabilities can be "Potential server-side request forgery (SSRF)", "Attacker can modify sensitive data or program variables" and "Abuse of JavaScript's prototype API possible (Prototype Pollution)".

How do I fix it?

In order to fix all of these vulnerabilities, update axios in tabby to 1.15.2 or upgrade one at a time below.

Subissues

16
Subissue
Fix
backend
tabby
CVE-2026-42043

Critical
pnpm-lock.yaml

View reachability analysis
1.13.5 => 1.15.1

CVE-2025-62718

Critical
pnpm-lock.yaml

View reachability analysis
1.13.5 => 1.15.0

CVE-2026-42044

Critical
pnpm-lock.yaml

View reachability analysis
1.13.5 => 1.15.2

CVE-2026-40175

High
pnpm-lock.yaml

View reachability analysis
Upgraded: Exploit available on Github

1.13.5 => 1.15.0

CVE-2026-42039

High
pnpm-lock.yaml

View reachability analysis
1.13.5 => 1.15.1

CVE-2026-42038

High
pnpm-lock.yaml

View reachability analysis
1.13.5 => 1.15.1

CVE-2026-42264

High
pnpm-lock.yaml

View reachability analysis
1.13.5 => 1.15.2

CVE-2026-42035

High
pnpm-lock.yaml

View reachability analysis
1.13.5 => 1.15.1

CVE-2026-42033

High
pnpm-lock.yaml

View reachability analysis
1.13.5 => 1.15.1

CVE-2026-42041

Medium
pnpm-lock.yaml

View reachability analysis
1.13.5 => 1.15.1

CVE-2026-42042

Medium
pnpm-lock.yaml

View reachability analysis
1.13.5 => 1.15.1

CVE-2026-42037

Medium
pnpm-lock.yaml

View reachability analysis
1.13.5 => 1.15.1

CVE-2026-42036

Medium
pnpm-lock.yaml

View reachability analysis
1.13.5 => 1.15.1

CVE-2026-42034

Medium
pnpm-lock.yaml

View reachability analysis
1.13.5 => 1.15.1

AIKIDO-2026-10509

Medium
pnpm-lock.yaml

View reachability analysis
1.13.5 => 1.15.1

CVE-2026-42040

Low
pnpm-lock.yaml

View reachability analysis
1.13.5 => 1.15.1

## Template Injection Github Workflows - in deploy-production.yaml and ci.yaml - Critical

100

Critical

Template Injection in GitHub Workflows Action

We found 2 issues: last detected 2 days ago

To do
SAST
TL;DR

A GitHub Actions workflow step contains a template expression referencing potentially untrusted GitHub context fields. This may allow malicious input to be injected into shell commands, leading to a potential supply chain attack as tokens of the CI/CD pipeline could be exfiltrated.

How do I fix it?

Review your GitHub Actions workflow for any template expressions that interpolate GitHub context values, especially those ending with unsafe suffixes such as 'body', 'title', 'email', 'head_ref', etc. Sanitize or validate these inputs before use, or refactor the workflow to avoid directly embedding untrusted data in shell commands.
More information

Show more
Subissues

2
Subissue
backend
tabby
.github/workflows/ci.yaml

Critical
Line 31 in ci.yaml

run: echo "${{ github.event.pull_request.title }}" | npx commitlint --verbose
View code analysis
Upgraded: Finding dangerous in public repo

.github/workflows/deploy-production.yaml

Critical
Line 29 - 34 in deploy-production.yaml

run: |
  if [ "${{ github.event.inputs.confirm }}" != "deploy" ]; then
    echo "::error::You must type 'deploy' to confirm. Got: '${{ github.event.inputs.confirm }}'"
    exit 1
  fi
View code analysis
Upgraded: Finding dangerous in public repo

## lodash - Attacker can inject own code to run - Critical
99

Critical

lodash

Affected by 2 CVEs: last detected 10 hours ago

PR open
Dependency
TL;DR

lodash is affected by 2 vulnerabilities. To learn more about each one, consult the table below.The worst case impact for these vulnerabilities can be "Attacker can inject own code to run" and "Abuse of JavaScript's prototype API possible (Prototype Pollution)".

How do I fix it?

In order to fix all of these vulnerabilities, update lodash in tabby to 4.18.1 or upgrade one at a time below.

Subissues

2
Subissue
Fix
backend
tabby
CVE-2026-4800

Critical
pnpm-lock.yaml

View reachability analysis
Upgraded: Exploit available on Github

4.17.23 => 4.18.1

CVE-2026-2950

Medium
pnpm-lock.yaml

View reachability analysis
4.17.23 => 4.18.0

## Next.js - Potential server-side request forgery (SSRF) - High
86

High Risk

Next.js

Affected by 15 CVEs: last detected 10 hours ago

New
Dependency
TL;DR

Next.js is affected by 15 vulnerabilities. To learn more about each one, consult the table below.The worst case impact for these vulnerabilities can be "Potential server-side request forgery (SSRF)", "Authentication bypass possible" and "Attacker can trigger DOS-attack".

How do I fix it?

In order to fix all of these vulnerabilities, update Next.js in tabby to 15.5.16 or upgrade one at a time below.

Subissues



## @slack/bolt - Attacker can abuse improper authentication
85

High Risk

@slack/bolt

Affected by 1 CVE: last detected 10 hours ago

New
Dependency
TL;DR

Incoming Slack HTTPS probes carry only `ssl_check` metadata during SSL handshake verification, but HTTP adapters treated any truthy `ssl_check` form field as an unconditional exemption from Slack signing-secret verification instead of requiring the canonical literal string value Slack specifies; malformed truthy tokens therefore skipped crypto verification altogether while additional URL-encoded pairs appended alongside could piggyback on that exemption unless stripped upstream of verification routing. The implementation now accepts bypass exclusively when `ssl_check` equals exactly `1` and rejects non-canonical variants before verifying signatures on ordinary webhook payloads.

Show more
Does this affect me?

You are affected if you are using a version that falls within the vulnerable range.


How are you using it
How do I fix it?

Upgrade the `@slack/bolt` library to the patch version.

## Express is not emitting security headers - in health-server.ts - High
85

High Risk

Express is not emitting security headers

We found 1 issue: last detected 2 days ago

To do
SAST
TL;DR

You're using an Express server, but not using Helmet. Helmet can help protect your app from some well-known web vulnerabilities by setting HTTP headers. Examples are HSTS headers that enforce SSL, CSP headers that protect against XSS attacks. Other headers protect against putting your app in an iframe to launch social engineering attacks which could be used for account takeovers. 

How do I fix it?

Use the Helmet express middleware with: 
const helmet = require("helmet"); 
 app.use(helmet());

## Detected a Generic API Key, potentially exposing access to various services and sensitive operations. - in e2e_uat_22_4.py - High
80

High Risk

Detected a Generic API Key, potentially exposing access to various services and sensitive operations.

We found 1 issue: first detected 1 month ago

To do
Secrets
TL;DR

We detected secret *****2345 in the git history of the tabby repository. The secret was found in scripts/e2e_uat_22_4.py@ this commit ->

How do I fix it?

If this API key is harmless, you can ignore this issue. If not, we would advise to move the secret out of the git repository by either injecting it via the environment or even better, by using a tool such as AWS Secrets Manager to inject the secrets at run-time. After that, it should be possible to invalidate the current secret and regenerate a new one.

Note: Exposed secrets need to be marked as resolved manually. Even after removal it will still be available in the git history of your repository. That means it could still leak if someone has access to your source code.

## Detected a Generic API Key, potentially exposing access to various services and sensitive operations - in STARTUP.md - High
Detected a Generic API Key, potentially exposing access to various services and sensitive operations.

We found 1 issue: first detected 1 month ago

To do
Secrets
TL;DR

We detected secret *****2345 in the git history of the tabby repository. The secret was found in STARTUP.md@ this commit ->

How do I fix it?

If this API key is harmless, you can ignore this issue. If not, we would advise to move the secret out of the git repository by either injecting it via the environment or even better, by using a tool such as AWS Secrets Manager to inject the secrets at run-time. After that, it should be possible to invalidate the current secret and regenerate a new one.

Note: Exposed secrets need to be marked as resolved manually. Even after removal it will still be available in the git history of your repository. That means it could still leak if someone has access to your source code.

## 4 exposed secrets - in values.yaml and values-local.yaml - High
80

High Risk

5 exposed secrets

We found 4 issues: first detected 1 month ago

To do
Secrets
TL;DR

We detected some exposed secrets in the git history of tabby. The secrets were found in charts/browser-hitl/values.yaml and charts/browser-hitl/values-local.yaml

How do I fix it?

If this API key is harmless, you can ignore this issue. If not, we would advise to move the secret out of the git repository by either injecting it via the environment or even better, by using a tool such as AWS Secrets Manager to inject the secrets at run-time. After that, it should be possible to invalidate the current secret and regenerate a new one.

Note: Exposed secrets need to be marked as resolved manually. Even after removal it will still be available in the git history of your repository. That means it could still leak if someone has access to your source code.

Subissues



## Potential file inclusion attack via reading file - in streaming.controller.ts and credential-resolver.ts - High
80

High Risk

Potential file inclusion attack via reading file

We found 3 issues: last detected 2 days ago

To do
SAST
TL;DR

If an attacker can control the input leading into the ReadFile function, they might be able to read sensitive files and launch further attacks with that information.

How do I fix it?

Ignore this issue only after you've verified or sanitized the input going into this function. This issue is only relevant in the backend, not in the frontend! 

Subissues

3

## multer - Attacker can exploit incomplete cleanup - High
76

High Risk

multer

Affected by 3 CVEs: last detected 10 hours ago

To do
Dependency
TL;DR

multer is affected by 3 vulnerabilities. To learn more about each one, consult the table below.The worst case impact for these vulnerabilities can be "Attacker can exploit incomplete cleanup" and "DoS possible due to infinite loop".

How do I fix it?

In order to fix all of these vulnerabilities, update multer in tabby to 2.1.1 or upgrade one at a time below.

Subissues



## path-to-regexp - Attacker can trigger DOS-attack - High
75

High Risk

path-to-regexp

Affected by 3 CVEs: last detected 10 hours ago

To do
Dependency
TL;DR

path-to-regexp is affected by 3 vulnerabilities. To learn more about each one, consult the table below.The worst case impact for these vulnerabilities can be "Attacker can trigger DOS-attack" and "Attacker can trigger DOS-attack via regex".

How do I fix it?

In order to fix all of these vulnerabilities, update path-to-regexp in tabby to 8.4.0 or upgrade one at a time below.

## fast-xml-parser - Attacker can trigger buffer overflow leading to crash or RCE - High
75

High Risk

fast-xml-parser

Affected by 5 CVEs: last detected 10 hours ago

PR open
Dependency
TL;DR

fast-xml-parser is affected by 5 vulnerabilities. To learn more about each one, consult the table below.The worst case impact for these vulnerabilities can be "Attacker can trigger buffer overflow leading to crash or RCE" and "Attacker can trigger DOS-attack".

How do I fix it?

In order to fix all of these vulnerabilities, update fast-xml-parser in tabby to 5.7.2 or upgrade one at a time below.
