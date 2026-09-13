# Architecture

Toolkit is a collection of independent packages, not a framework imposed on consuming repositories.

## Package boundaries

`claude-token-optimisation` owns Claude Code agent and hook assets. `agent-workflow` owns bounded model handoff and ticket-launch concepts. `image-generation` owns prompt-batch execution and resumable state. `image-to-3d` owns image-to-model queue processing.

Packages may share small, dependency-free utilities only when the shared contract is demonstrably stable. No package imports another merely because the same repository contains it.

## Configuration and state

Configuration is explicit and portable: command-line arguments, environment variables, or a local configuration file. Runtime state is caller-selected and ignored by source control. Packages do not contain personal paths, network-share paths, prompt libraries, generated assets, credentials, or scheduler definitions.

## Integrations

An integration is opt-in installable content for a particular host product. It is never activated by a library dependency. The first integration targets Claude Code; future integrations must have their own directory and documentation.
