# Built-in templates

`knowledge-atlas` is the Phase 8 Page IR v1 template. Each Self Root receives its own
copy during initialization so archived Artifact builds never depend on a global install.

The renderer treats template and theme files as trusted local product assets. Source
content is always passed as React text and is never inserted as raw HTML.
