# Security and operating boundaries

Credentials are supplied only through environment variables and are never written to reports, logs, or source-controlled configuration. Model handoff is disabled unless explicitly enabled and can modify only paths declared in its task file. Review every applied diff.

Image runners are caller-supplied executables. Queue and prompt identifiers reject parent traversal. Image-to-3D relative paths cannot escape the supplied source root.

Runtime state, logs, generated images, model outputs, and provider transcripts belong outside source control. Use a local state directory or project ignore rules.
