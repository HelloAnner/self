# Self platform packages

Release automation stages each platform package from reviewed source metadata, then removes the development-only private flag inside the isolated release directory. Every package contains the standalone binary, compatible SQLite library, sqlite-vec extension, migrations, templates, checksums, manifest, SBOM, and third-party licenses. Platform packages and the meta-package always use the same exact version.
