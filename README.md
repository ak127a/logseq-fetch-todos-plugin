# Fetch TODOs (Logseq Plugin)

Fetch TODO items from a referenced page and insert links to selected tasks into your current location.

![Fetch TODOs plugin logo](./logo.png)

## What it does

- Detects a page reference like `[[My Project]]` from the current block (or its parent block).
- Scans that page for blocks that start with `TODO`.
- Shows a selector UI so you can choose one or more TODOs.
- Inserts block references (`((uuid))`) for selected TODOs into the current position.

## How to use

1. In a block (or its parent), include a page reference like `[[My Project]]`.
2. Run one of these commands:
   - Command palette: `Fetch TODOs from page`
   - Slash command: `Fetch TODOs`
3. Select TODOs from the popup.
4. Click `Add TODOs`.

## Development

This plugin is currently a plain JavaScript Logseq plugin with:

- `index.html` as the plugin entry.
- `index.js` for plugin logic.

## Release

This repository includes two GitHub Actions workflows:

- `.github/workflows/auto-release.yml` creates a GitHub release on push to `master`/`main` using `v<package.json version>`.
- `.github/workflows/publish.yml` builds and uploads the plugin zip for that release.

Notes:

- Auto-release dispatches the publish workflow automatically after creating a new release.
- To create a new release, bump `package.json` version before pushing.
- If a release/tag for that version already exists, auto-release will skip.
