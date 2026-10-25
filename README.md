# Upload builds from CI

Make `git push` your release step. A CI job uploads the folder your build
produced; Omnihorn stores it as a new build of your app, and every channel that
follows the pushed branch starts offering it to installed copies of your app.

## Concepts

- **API key.** Each app has its own upload keys (`nk_…`), created on the app's
  **CI/CD** tab. A key can publish builds to that app — to any channel it
  names and to every channel that follows the branch it reports. Treat it like a
  release credential. It cannot read other apps, keys or billing. It is shown once — store
  it as a CI secret. An app can have 10 active keys; revoking one takes effect on
  the very next request.
- **Build source.** A build uploaded from CI remembers its branch (or tag), commit,
  commit message, who pushed it and a link to the CI run. The dashboard shows the
  branch and short commit next to every such build.
- **Following a branch.** A channel can follow a branch: an exact name such as
  `main`, or a pattern where `*` matches anything, including `/` —
  `release/*` matches `release/1.0` and `release/1.0/hotfix`. When a build from a
  matching branch has been scanned, verified and signed, it is assigned to every
  channel that follows that branch. Set it on the channel page, card
  **Follow a branch**.
- **Branch channels.** A push to a branch that no channel follows creates a
  channel for it: named after the branch (`feature/Login` → `feature-login`),
  **private** (installers need a token or password to use it) and following that
  branch. Your plan's channel limit applies: at the limit the build is still
  created, no channel is, and the job summary says so. Turn it off per workflow
  with `create-branch-channel: false`.
- **Tags** create no branch channel and follow nothing; name a channel with the
  `channel` input to ship a tag build.

## Quickstart

1. In Omnihorn, open your app → **CI/CD** → **Create key**. Copy the key.
2. In GitHub, open the repository → **Settings → Secrets and variables → Actions**
   → **New repository secret**, name it `OMNIHORN_API_KEY`, paste the key.
3. Copy the workflow from the **CI/CD** tab into `.github/workflows/release.yml`
   (or use the one below).
4. Replace the build step with your own; make sure the files end up in `./dist`.
5. Push. The job summary shows the version, the branch and what happened to your
   channels.

```yaml
name: "Release my app"

on:
  push:
    branches: [main, 'release/**']   # see the note below

jobs:
  release:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4

      # Build your app here so that its files end up in ./dist
      - name: Build
        run: echo "Replace this step with your build command"

      - uses: Ivorn-Technologies/upload-build@v1
        with:
          api-key: ${{ secrets.OMNIHORN_API_KEY }}
          path: ./dist
```

Always give `on: push` a `branches:` filter. Without one, every push runs the job:
Dependabot pushes fail (Dependabot gets no repository secrets, so the key is
empty), and every merge-queue ref (`gh-readonly-queue/...`) would create its own
branch channel. Pull requests from forks or Dependabot (`pull_request` with no
key) are skipped with a notice instead of failing.

## Examples

### `main` goes to production

Either make the channel follow the branch — open the `production` channel, set
**Follow a branch** to `main` — and keep the workflow as it is, or name the
channel in the workflow:

```yaml
      - uses: Ivorn-Technologies/upload-build@v1
        if: github.ref == 'refs/heads/main'
        with:
          api-key: ${{ secrets.OMNIHORN_API_KEY }}
          path: ./dist
          channel: production
```

Naming a channel also stops a separate `main` channel from being created. A
channel that follows a branch is updated by every matching push; you can still
assign an older build by hand (a rollback), and the next push replaces it.

### Feature branches

Nothing to configure: every new branch gets its own private channel
(`feature/new-editor` → `feature-new-editor`). Hand its token to testers from the
channel page. To keep them all on one channel instead, create a channel `preview`
that follows `feature/*`.

### Tags and releases

```yaml
on:
  push:
    tags: ['v*']

jobs:
  release:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - name: Build
        run: echo "Replace this step with your build command"
      - id: version
        shell: bash
        run: echo "value=${GITHUB_REF_NAME#v}" >> "$GITHUB_OUTPUT"
      - uses: Ivorn-Technologies/upload-build@v1
        with:
          api-key: ${{ secrets.OMNIHORN_API_KEY }}
          path: ./dist
          version: ${{ steps.version.outputs.value }}
          channel: stable
```

The `version` step turns the tag `v1.4.0` into the base version `1.4.0`; Omnihorn
appends `+build.N`. Without `version` the latest build's base version is reused.

### Several apps in one repository (matrix)

Create one key per app and store them as separate secrets:

```yaml
jobs:
  release:
    runs-on: windows-latest
    strategy:
      matrix:
        include:
          - app: editor
            key: OMNIHORN_API_KEY_EDITOR
          - app: viewer
            key: OMNIHORN_API_KEY_VIEWER
    steps:
      - uses: actions/checkout@v4
      - name: Build
        run: echo "Build ${{ matrix.app }} into dist/${{ matrix.app }}"
      - uses: Ivorn-Technologies/upload-build@v1
        with:
          api-key: ${{ secrets[matrix.key] }}
          path: dist/${{ matrix.app }}
```

Parallel jobs uploading to the **same** app are fine too: each build gets its own
number, and a following channel never moves to a lower build number.

## Inputs

| Input | Default | |
|---|---|---|
| `api-key` | — | The app's key, from a secret. Required. |
| `path` | — | The folder whose files make up the build. Required. Symbolic links and `.git` are skipped. |
| `version` | latest | Base version `MAJOR.MINOR.PATCH`; Omnihorn appends `+build.N`. |
| `release-notes` | empty | "What's new" for the build (up to 10,000 characters), shown by the installer before an update. Can be added or edited later on the build's page in the dashboard. |
| `channel` | none | Also assign the build to this existing channel once it is active. |
| `create-branch-channel` | `true` | Create a private channel for a branch nobody follows yet. |
| `wait` | `true` | Wait until the build is active or failed, up to 15 minutes. |
| `api-url` | `https://api.omnihorn.com` | Only for a self-hosted or test backend. |

## Outputs

| Output | |
|---|---|
| `build-id` | The build's id. |
| `version` | The full version, e.g. `1.4.0+build.42`. |
| `status` | `active`, `failed`, or `processing` with `wait: false`. |
| `channels` | JSON: `[{ "channelId", "name", "action": "assigned" \| "created" \| "unchanged", "reason"? }]`. |

The step fails (exit code 1) when the upload fails, the build fails
verification, or the build is deleted before the step finishes; the message
names the file or the step.

## Troubleshooting

| You see | Meaning and fix |
|---|---|
| `The API key was refused` (401) | The secret is empty, mistyped, or the key was revoked. Create a new key and update `OMNIHORN_API_KEY`. |
| `This app is suspended` / `workspace is suspended` (403) | Contact Omnihorn support. |
| Retries with "Too many requests" (429) | More than 60 requests a minute with one key. The action waits and retries; use one key per repository. |
| `Storage limit reached` | Your plan's storage is full. Files already uploaded before do not count again; deleting builds you no longer need gives their space back within minutes. |
| `This app has N builds, the most the … plan keeps` (403) | Every build of the app is live on a channel, pinned or among its 3 newest, so none could make room. Unpin or delete a build on the dashboard, or upgrade. Below that, each upload at the limit removes the oldest unused build (a failed one first) to make room. |
| A branch channel disappeared | Private channels created automatically for a branch are removed after your plan's branch-channel period without a push or an update check (Indie 14 days, Pro 30, Studio 60, Enterprise 90). The next push to the branch creates it again. Use "Keep this channel" on the dashboard to keep one for good; public channels are never removed automatically. |
| "No branch channel was created: the plan's channel limit is reached" | The build is there, unassigned. Upgrade, delete a channel, or make an existing channel follow the branch. |
| No channel was created and no note | Something follows the branch already (check the job summary), you set `channel`, `create-branch-channel: false`, or it is a tag build. |
| "channel … unchanged (a newer build is already there)" | A later push of the same branch finished first. Nothing to do. |
| "… the plan's live installer limit" | Assigning the build would put more installer designs live than your plan allows. |
| "`x` of `y` files were already uploaded" | Normal: unchanged files are never uploaded twice. |
| "still processing after 15 minutes" | Large builds can take longer to scan. The build may still finish — see the Builds tab, or set `wait: false`. |
| `HASH_MISMATCH` / `SIZE_MISMATCH` | A file changed while it was being uploaded. Re-run the job. |
| `FILE_RECLAIMED: …` | A file the build reused from an earlier upload was removed from storage in the meantime (old builds are cleaned up). Re-run the job: this time the file is uploaded again. |
| `This app is busy with another upload or a cleanup` (`BUILD_BUSY`, 503) | Another upload or the nightly cleanup held the app for a moment. The action waits the time the server asks for and retries 4 times; if it still fails, re-run the job. |
| `… has not been uploaded by this workspace` (`FILE_NOT_OWNED`) | A build deleted at the same moment gave a file back. The action checks and uploads once more by itself; seeing this means it happened twice in a row — re-run the job. |
| "channel … unchanged (the build was deleted before it reached the channel)" | The build was deleted (on the dashboard, or by the plan's build limit) before the channel could take it. Upload again. |
| "Build … was deleted" / Status "… — deleted" | The build was deleted while the job waited for it; it will never be served. The step fails. |

## Security

- Keep the key in a secret; never print it. The action sends it only in an HTTP
  header to the Omnihorn API — never to storage, never in a URL — and never logs it.
- **Pull requests from forks** get no secrets. The action then skips the upload
  with a notice and succeeds, so forks do not fail your checks.
- Branch channels are private, so a build of an unfinished branch is not
  world-readable.
- **Rotate** a key by creating a new one, updating the secret, then revoking the
  old one. A leaked key can publish builds to one app (to any channel it
  names, and to channels following the branch it reports), so treat it like a
  release credential: revoke it at once, then check the Builds and Channels tabs.

## Other CI systems

The same code runs as a command-line tool (Node 20.10 or later). Download
`dist/cli.js` from the action repository and give the job the key as
`OMNIHORN_API_KEY`:

```bash
curl -fsSL https://raw.githubusercontent.com/Ivorn-Technologies/upload-build/v1/dist/cli.js -o omnihorn-upload.js
node omnihorn-upload.js --path ./dist --channel production
node omnihorn-upload.js --help
```

On GitLab CI the branch, tag, commit, title, user and pipeline URL are read from
GitLab's own variables:

```yaml
release:
  image: node:20
  script:
    - ./build.sh   # puts the app into ./dist
    - curl -fsSL https://raw.githubusercontent.com/Ivorn-Technologies/upload-build/v1/dist/cli.js -o omnihorn-upload.js
    - node omnihorn-upload.js --path ./dist
  variables:
    OMNIHORN_API_KEY: $OMNIHORN_API_KEY   # a masked CI/CD variable
```

Elsewhere (CircleCI, Jenkins, Azure Pipelines…) pass what you know:

```bash
node omnihorn-upload.js --path ./dist --provider other --branch "$BRANCH" --commit "$SHA"
```
