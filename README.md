# Open Editor Platform

A host-independent editor workspace for documents, structured data, graphs,
text review, file inspection, whiteboards, design, slides, registered React UI,
2D animation and local geographic data.
The local editor needs no backend, authentication, API key or AI service.

## Run

Use Node.js **24.19.0** (minimum 22.13), npm and Python **3.10+**.
The first font download requires network access.

```sh
npm ci
npm run fonts:fetch
npm run dev
```

Open the URL printed by Vite (normally http://localhost:5173).
Local drafts and immutable versions live in this browser's IndexedDB.
Export native JSON for a portable backup; clearing browser storage removes local data.
See [assets and environment setup](docs/repository-assets.md) for font preparation.

Run an optional reference service in another terminal when needed:

| Command                        | Purpose                             |
| ------------------------------ | ----------------------------------- |
| `npm run collaboration:server` | In-memory shared-editing authority  |
| `npm run react-ui:dev`         | Registered React preview/build Host |
| `npm run artifact-host:dev`    | Independent artifact editing Host   |

## Use and integrate

The Playground artifact library creates editable artifacts and offers templates
for supported domains. Editing a draft and saving an immutable version are separate
operations. Formats, shared editing and reuse support vary by Editor.
See [status and limits](docs/status.md) and [Surface contracts](docs/surface-semantics.md).

Import workspace packages through public `@editor-platform/*` entrypoints.
Packages expose TypeScript source for a bundler-aware Host.
See [embedding](docs/embedding.md), [Host integration](docs/host-integration.md)
and [shared-editing coverage](docs/editor-collaboration-coverage.md).
Authentication, organization policy, durable services and AI execution belong to the Host.

## Development and documentation

Use the [documentation index](docs/README.md) to find a guide or contract,
and the [writing policy](docs/documentation-guide.md) to choose where to update it.
Start development with the [developer guide](docs/developer-guide.md).
New Editors and substantial additions use the [development guide](docs/editor-development.md),
[acceptance criteria](docs/editor-acceptance.md) and their design/verification templates.

```sh
npm run check:files
npm run test:tooling
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e
```

If system Chromium is unavailable, first run `npx playwright install --with-deps chromium`.
Browser checks cover desktop/mobile viewports and fail on browser errors.
Generated reports, screenshots and exports stay outside Git.
See [assets and verification](docs/repository-assets.md) for additional environments.

## Updates and contributions

This repository receives reviewed, sanitized snapshots with independent Git history.
See [CONTRIBUTING](CONTRIBUTING.md). Maintainers reconcile shared changes in the
canonical source before synchronization. A snapshot update does not certify all
release, performance or external-product acceptance checks.
Third-party notices and provenance remain attached to their assets.

## License

Open Editor Platform is proposed for licensing under **GNU AGPLv3-only**
([LICENSE](LICENSE)) **or** an alternative written commercial/OEM agreement
from duly authorized rightsholders. AGPLv3 permits **commercial use, sale,
redistribution and SaaS** when its terms are satisfied, without a license fee
to the project. Companies needing a closed-source licensing path may negotiate
an alternative agreement. A paid product alone does not require an OEM license.

See [dual licensing](DUAL-LICENSING.md), [license guide](LICENSE-GUIDE.md),
[commercial OEM](COMMERCIAL-LICENSING.md), [third-party scope](LICENSE-SCOPE.md),
and [the proposed, not-yet-adopted independent Editor exception](ADDITIONAL-PERMISSION-DRAFT.md).
Prior MIT copies keep their earlier license; project dependencies, fonts and
fixtures keep their own notices. This repository's release is not yet approved.

## Preview release and support

The project is preparing an AGPLv3 OSS Preview. Release candidates require
recorded rights/provenance, security, export-integrity and reproducible build/test
checks before becoming public. See [the OSS Preview release gate](docs/release/OSS-PREVIEW-GATE.md)
and [the current publication checklist](legal/PUBLICATION-READINESS.md).

Separate proprietary commercial/OEM licensing is **not yet being offered**;
[its launch gate](docs/release/COMMERCIAL-OEM-GATE.md) is independent of
AGPL-compliant usage. The [Independent Editor additional-permission draft](ADDITIONAL-PERMISSION-DRAFT.md)
is not an effective exception. The project provides no guaranteed security
updates, support or SLAs. See [Security Policy](SECURITY.md).
