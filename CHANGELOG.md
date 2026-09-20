# Changelog

## 0.1.0 - Unreleased

- Initial standalone packages for Claude context optimisation, bounded agent workflow, image generation, and image-to-3D conversion.
- Add `toolkit-sync`, a dependency-free script consuming repos use to pin a Toolkit release, detect local drift from that pin, and re-sync vendored package files from it (`packages/toolkit-sync`). Each vendorable package now declares its vendorable surface in a `toolkit-manifest.json`. Releases are tagged going forward (see `docs/release.md`); pin to a tag with `node packages/toolkit-sync/src/cli.mjs pin <package> <tag>`.
