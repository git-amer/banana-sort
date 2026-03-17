# Change Log

All notable changes to the "banana-sort" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

- Initial release
- Recursively process CSS rules inside `@` blocks so nested rules are sorted instead of treated as opaque text.
- Process nested selector blocks in rule bodies and place nested `&... {}` blocks after sorted declarations.
- Replace line-count messaging with per-character removal reporting using exact character counters (excluding whitespace characters).
