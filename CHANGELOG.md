# Changelog

All notable changes to right-size are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Plugin manifest metadata: author, homepage, repository, license and keywords.
- Marketplace description and category.
- This changelog.
- `cacheTtlMinutes` and `smallContextTokens` settings, so the cache guard can be tuned without editing source.
- CI on GitHub Actions: plugin validation, plugin tests and the benchmark selftest.
- Tests for follow-ups, slash commands, subagent steps, Haiku picks without effort, the `(ran …)` note, `/clear` and compaction.

### Fixed

- A judge reply that rambles (for example `opus high (haiku would be too weak)`) no longer parses as the lowest model it mentions; anything but the exact `<model> <effort> [urgent|normal]` answer now falls back to the session default.
- A judge call that throws no longer reuses the previous turn's pick silently; it falls back to the session default and the status line says so.
- A mode set with `/right-size-mode` now applies from the next turn, and `/right-size-mode` shows the current value instead of the one loaded at startup.
- `/clear` forgets the previous conversation's pick and cache state; compaction forgets the cache state.
- An unrecognized model id shows by its own name in the status line instead of as `fable`.

## [0.3.1] - 2026-10-20

### Added

- `/right-size-mode` command to show or set the mode from any surface, the desktop app included.
- MIT license.

## [0.3.0] - 2026-10-20

### Added

- `mode` setting with an `effort-only` option: keeps the session's model on every turn and changes only the effort, so the prompt cache is never lost.
- A/B benchmark (`bench/`) that runs real headless sessions with right-size on and off and compares cost, time and correctness, including multi-turn cases for the cache guard.

## [0.2.0] - 2026-10-20

### Added

- Urgent picks: the judge can mark a prompt too hard for the current model, which switches up even while a big chat's cache is hot.
- The judge is told which model the chat is on now.

### Changed

- A pick never goes above the session's own model.

## [0.1.0] - 2026-10-20

### Added

- First release: a Haiku judge picks model and effort per prompt, a cache guard keeps the current model in big chats with a hot cache, and one status line shows what actually ran.

[Unreleased]: https://github.com/RyunPey/right-size/compare/1d53d59...HEAD
[0.3.1]: https://github.com/RyunPey/right-size/compare/c78410e...1d53d59
[0.3.0]: https://github.com/RyunPey/right-size/compare/a14d54a...c78410e
[0.2.0]: https://github.com/RyunPey/right-size/compare/c8d0396...a14d54a
[0.1.0]: https://github.com/RyunPey/right-size/commit/c8d0396
