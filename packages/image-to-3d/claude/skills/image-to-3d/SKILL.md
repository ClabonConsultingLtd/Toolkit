---
name: image-to-3d
description: Convert explicit reference-image queues into textured GLB models through the Toolkit image-to-3D CLI. Use for batch image-to-model work; do not use browser automation when a service API is available.
---

# Image to 3D

Create an explicit JSON queue with `id`, `reference`, and `model` fields. Run a dry check before spending quota:

```bash
toolkit-image-to-3d queue.json --source-root . --dry-run
```

For conversion, the user supplies a valid service token in the configured token environment variable (default `HF_TOKEN`). Do not invent, retrieve, or expose credentials.

```bash
toolkit-image-to-3d queue.json --source-root . --results results.json --ledger ledger.json
```

Existing outputs are skipped unless `--overwrite` is explicitly supplied. Review the JSON report; a successful service call is not an artistic or production-quality approval.
