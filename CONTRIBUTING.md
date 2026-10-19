# Contributing

Thanks for helping! Bug reports, features, tests and docs are all welcome.

1. Fork, create a branch, `npm ci`.
2. Keep the runtime dependency-free (Node built-ins only); build tools go in `devDependencies`.
3. Add tests with every behaviour change (`test/*.test.js`, `node:test`; mock servers, no internet). Run `npm test` and `npm run test:ui`; on Windows also `npm run test:e2e` when you touch the native host, tray, installer or extensions.
4. Match the surrounding code style; keep the UI English.
5. The native host (`host/Program.cs`) is C# 5 so it compiles with the compiler that ships with Windows — no SDK, no NuGet packages besides the pinned WebView2 libraries. Build it with `npm run build:host`.
6. Screenshots in the README live in `docs/images/`; keep the wording free of other products' names.
7. Open a pull request using the template. Update the docs (`README.md`, `docs/`) and `CHANGELOG.md` when behaviour changes.

By contributing you agree your work is released under the [MIT licence](LICENSE).
