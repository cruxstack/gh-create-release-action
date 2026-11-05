# gh-create-release-action

Creates or updates a GitHub release, uploads assets, and publishes it through the GitHub API.

- Creates the release as a draft, uploads every asset, then publishes. A failed upload never leaves a
  half-finished release live, and repositories with immutable releases are supported.
- Never tags the default branch by surprise: a missing tag needs an explicit `release-target`.
- Updates send only the inputs you set.
- Asset files must stay inside the workspace; patterns that match nothing fail the step.
- No runtime dependencies. The token is only ever sent to the GitHub API.

## Usage

```yaml
on:
  push:
    tags: ["v*"]

permissions: {}

jobs:
  release:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@<full-commit-sha> # v7.0.1
        with:
          persist-credentials: false

      - run: make dist

      - id: release
        uses: cruxstack/gh-create-release-action@<full-commit-sha> # v1.0.0
        with:
          release-tag: ${{ github.ref_name }}
          release-notes-generate: true
          release-assets: |
            dist/*.tar.gz
            dist/checksums.txt
```

Pin the action to a full commit SHA. Release tags are immutable.

## Inputs

| Name | Default | Description |
|---|---|---|
| `github-token` | `github.token` | Token with `contents: write`. |
| `github-repository` | `github.repository` | Repository to release, as `owner/name`. |
| `release-tag` | | **Required.** Tag of the release. |
| `release-name` | tag | Release title. |
| `release-target` | | Commit SHA or branch to tag. Only used, and required, when the tag doesn't exist yet. |
| `release-body` | | Release notes. |
| `release-body-file` | | Workspace file containing the release notes. |
| `release-notes-generate` | `false` | Append GitHub's generated notes after the body. |
| `release-notes-previous-tag` | | Tag the generated notes start from. |
| `release-draft` | `false` | Leave the release as a draft. |
| `release-prerelease` | `false` | Mark the release as a prerelease. |
| `release-latest` | `true` | `true`, `false` or `legacy`. |
| `release-if-exists` | `fail` | `fail`, `skip` or `update`. |
| `release-assets` | | Workspace glob patterns of files to upload, one per line. |
| `release-assets-overwrite` | `false` | Replace existing assets with the same name. |

## Outputs

| Name | Description |
|---|---|
| `release-id` | Release ID. |
| `release-url` | Release page URL. |
| `release-operation` | `created`, `updated` or `skipped`. |
| `release-assets` | JSON array of `{name, url, size}` for assets uploaded by this run. |

## Behaviour

**New releases.** The release is created as a draft, assets are uploaded four at a time, and the
draft is published with `release-latest` unless `release-draft` is `true`. If any step fails, the
draft this run created is deleted so a re-run starts clean. When the tag doesn't exist, GitHub
creates it at `release-target` on publish; without `release-target` the step fails. When the tag
exists and `release-target` is a commit SHA, they must match.

**Existing releases.** Published releases are found by tag. Drafts aren't returned by that lookup, so
the release list is scanned for a draft with the same tag, and the newest one is used.
`release-if-exists` then decides:

- `fail` stops the step.
- `skip` returns the existing release with `release-operation: skipped`.
- `update` uploads assets first, then changes only the inputs that were set. `release-target` is
  only applied to drafts. A release that is immutable can't take new assets.

**Body.** `release-body` or `release-body-file` (up to 1 MiB), followed by GitHub's generated notes
when `release-notes-generate` is `true`. GitHub limits release bodies to 125,000 characters.

**Assets.** Patterns are matched with Node's built-in glob, relative to `GITHUB_WORKSPACE`.
Directories are skipped; links that resolve outside the workspace, empty files, files over 2 GiB and
patterns without matches fail before any API change. Asset names are the file names with characters
outside `A-Z a-z 0-9 . _ + -` replaced by `.`, so two files that map to the same name fail the step.

## Permissions

`contents: write`.

## Development

```sh
npm ci
npm test           # builds, then runs all tests offline
npm run coverage   # tests with coverage thresholds
```

Commit `dist/` together with source changes; CI fails when it is stale.

## License

[MIT](LICENSE)

## Acknowledgements

Thanks to [ncipollo/release-action](https://github.com/ncipollo/release-action), which inspired this
action.
