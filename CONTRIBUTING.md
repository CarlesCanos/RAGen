# Contributing

Thanks for helping improve RAGen Local. Keep changes focused, local-first, and easy to
run on Windows. By participating, you agree to follow the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Development setup

Use Node.js 22.18 or later from the repository root:

```powershell
npm.cmd ci
npm.cmd run typecheck
npm.cmd test
```

Live integration tests also require Ollama, Chroma, the configured models, and a prepared
index. Regular tests do not require those services.

## Pull requests

1. Create a short feature or fix branch.
2. Make one focused change.
3. Add or update tests for changed behavior.
4. Run type-checking and tests.
5. Update current documentation when behavior changes.
6. Open a pull request and explain the reason for the change.

Never commit `.env` files, runtime data, indexes, conversations, downloaded models,
personal document folders, credentials, or logs containing document text.

Report vulnerabilities through the process in [SECURITY.md](SECURITY.md), not through a
public issue.
