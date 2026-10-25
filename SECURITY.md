# Security policy

Thank you for helping keep Diffinery and the people who use it safe.

## Reporting a vulnerability

**Please don't report security problems in public issues, pull requests or discussions.**

Report them privately through the form at
[diffinery.com/security/report](https://diffinery.com/security/report). You don't need an
account. Only the maintainers can read what you send, and the form gives you a reference
number to quote if you write again. Every Diffinery instance serves its own
[`/.well-known/security.txt`](https://diffinery.com/.well-known/security.txt) with the same
form as its first contact.

A good report says what is affected (a URL, API endpoint, git or MCP operation, CLI
command or file in this repository), the steps or a short script that reproduce it, what
an attacker could do with it, and when you would like to publish.

The full policy, including what is in scope, safe harbour for good-faith research and the
response times we aim for, is at
[diffinery.com/docs/security/disclosure](https://diffinery.com/docs/security/disclosure).

## Supported versions

Diffinery is deployed continuously from `main`, and only the latest `main` gets security
fixes. If you run your own instance, update it regularly (re-run `scripts/setup.sh` or
your Deploy workflow); see
[Updating](https://diffinery.com/docs/self-hosting/deploy#updating).

## Instances you don't run

A problem in Diffinery's code should be reported here, even if you found it on someone
else's instance. Only test on an instance you run yourself or have permission to test.
Problems in Cloudflare's platform go to [Cloudflare](https://www.cloudflare.com/disclosure/).
