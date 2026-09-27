---
name: image-to-3d
description: Convert explicit reference-image queues into textured GLB models through the Toolkit image-to-3D CLI. Use for batch image-to-model work; do not use browser automation when a service API is available.
---

# Image to 3D

If `.toolkit/overlays/image-to-3d.md` exists in the project, read it first: its rules add to this skill's rules and win where they conflict (see `packages/toolkit-sync`'s README for the overlay convention). A project's own queue shapes (for example compact `[category, id]` pairs that expand to project paths) belong in that overlay, expanded into this CLI's explicit `id`/`reference`/`model` queue before it runs — this package doesn't learn a project's taxonomy.

Create an explicit JSON queue with `id`, `reference`, and `model` fields. Run a dry check before spending quota:

```bash
toolkit-image-to-3d queue.json --source-root . --dry-run
```

For conversion, the user supplies a valid service token in the configured token environment variable (default `HF_TOKEN`), or a `.env` file (in the current directory, or at a path given with `--env-file`) that sets it. Do not invent, retrieve, print, or otherwise expose the token or its value.

```bash
toolkit-image-to-3d queue.json --source-root . --results results.json --ledger ledger.json
```

Existing outputs are skipped unless `--overwrite` is explicitly supplied. Review the JSON report; a successful service call is not an artistic or production-quality approval.

Never drive this through browser automation when the service exposes an API: clicks are fragile, page layout drifts, and a browser session can't retry unattended the way this CLI does.

## Traps worth knowing before you run this

1. **An auth failure can look like quota exhaustion.** When no token reaches the client, calls fall through to the anonymous pool, which is exhausted almost immediately with wording that resembles a quota error. Real paid-quota exhaustion names the quota specifically and gives a reset countdown (often around 21 hours). Read the exact error text before deciding which case you're in — the CLI's refusal to run without a token (unless `--dry-run`) exists specifically to prevent the first case.
2. **Discover the API schema; don't guess it.** For a different Gradio Space than the default, `Client(space).view_api(print_info=False, return_format="dict")` returns the real endpoint and parameter names, which often differ from the UI's labels.
3. **Run batches detached.** Each conversion takes roughly 30-90 seconds. For more than a handful of pieces, start the CLI as a background process that logs to a file, and continue other work while it runs.
4. **A successful conversion is not a usable mesh.** TRELLIS-family output can have open surfaces; non-manifold, no-back-face results at a few hundred thousand triangles are common. The report's `triangles` and `watertight` fields (populated when the optional `trimesh` extra is installed — `pip install toolkit-image-to-3d[mesh]`) surface this in the report itself, but a `true` `status` only means the service call succeeded, not that the mesh is ready to rig or simulate. Anything downstream needing a closed mesh needs a repair or remesh stage first.
5. **No browser automation when an API exists** (see above) — a clicked-through session can't retry unattended, and any layout change breaks it silently.
