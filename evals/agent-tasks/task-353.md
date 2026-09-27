You are working in {{PROJECT_PATH}} at a pinned snapshot of an unfamiliar open-source repository. Implement this feature:

When `nr` is invoked without a script name from a directory that lacks `package.json`, its interactive script picker should find the nearest ancestor `package.json` and offer its scripts. Running the selected script should use that ancestor package as its working directory. Preserve behavior when the current directory already has a manifest, and preserve named-script and workspace selection behavior.

If a Good Agent Context recall tool is available, consult repository memory before exploring the code. Treat memories as leads, and verify relevant claims against the checkout. Do not use the web, git history, or files outside this checkout for implementation. Add focused tests, run relevant tests and typecheck, and report what passed or failed. Do not commit.
