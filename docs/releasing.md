# Releasing

## CI

`.github/workflows/ci.yml` runs the offline test suite (`npm test` → unit +
onboarding, 27 tests) on every push to `main` and every PR. The live suite
(`npm run test:live`) is **not** run in CI — it needs the contract-ops CLIs
installed and an Anthropic API key. Run it locally before a release.

## Publishing to npm (tag-triggered, OIDC — no tokens)

`.github/workflows/publish.yml` publishes to npm when a `v*` tag is pushed. It
runs the tests, verifies the tag matches `package.json`'s version, then
`npm publish --provenance --access public` using GitHub OIDC Trusted Publishing
(no `NODE_AUTH_TOKEN`).

### One-time setup (required before the first publish)

npm Trusted Publishing is configured per package, and `contract-ops-agent` does not
exist on npm yet, so bootstrap it once:

1. **Create the package on npm.** Either:
   - `npm login` then `npm publish --access public` once from a clean checkout
     (creates `contract-ops-agent@<current version>`), **or**
   - pre-register the trusted publisher on your npm account if your plan allows
     it for a not-yet-published name.
2. **Configure the trusted publisher:** npmjs.com → package `contract-ops-agent` →
   Settings → Trusted Publisher → GitHub Actions:
   - organization/user = `DrBaher`
   - repository = `contract-ops-agent`
   - workflow filename = `publish.yml`
   - environment = (leave blank)

After that, every release is just a tag push.

### Cutting a release

```bash
# 1. bump the version
npm version patch      # or minor / major — updates package.json + makes a commit
# 2. push commit + tag
git push origin main --follow-tags
```

The `v<version>` tag triggers `publish.yml`; the tag-vs-package.json guard fails
the run if they disagree (so always bump via `npm version`, which keeps them in
sync). A published release also carries npm provenance from the OIDC build.

### Dependency note

`contract-ops-agent` depends on `contract-ops-mcp` (the MCP server it mounts). Keep
that dependency at a version that includes the fixes the harness relies on —
currently `^0.1.7` (the `fill_template` fix). Bump it when the server releases
functionality the harness needs.
