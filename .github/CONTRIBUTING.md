# Contributing Guidelines

Thank you for contributing! Please follow these guidelines to maintain code quality and security.

## Security First

- **Never commit secrets**: API keys, tokens, credentials, or passwords
- Gitleaks runs on every commit to catch secrets automatically
- If you accidentally commit a secret, alert immediately
- See [SECURITY.md](../SECURITY.md) for reporting procedures

## CI/CD Requirements

All pull requests must pass:
- ✅ Semgrep (static security analysis)
- ✅ Gitleaks (secrets detection)
- ✅ Build verification
- ✅ All status checks

**Branch protection is enabled**: PRs require passing status checks, review, and
conversation resolution before merging.

## Submitting Changes

1. Create a feature branch
2. Make focused commits
3. Push to your branch
4. Open a PR with a clear description
5. Address review feedback
6. Merge after CI passes and approval

## Getting Help

See [SECURITY.md](../SECURITY.md) for security concerns or
[BRANCH_PROTECTION.md](BRANCH_PROTECTION.md) for merge requirements.
