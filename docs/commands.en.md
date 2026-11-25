# Command reference

[中文](commands.md) | **English**

All commands support `--json`; consult each command's `--help`. Remote objects accept absolute workspace paths or `id:<id>`. Local paths apply only to put/get. Relative remote paths are unsupported.

Use `--lang en|zh|auto`, `DECKFLOW_LANG`, or `config set lang en|zh|auto` to select a language. These sources take precedence in that order; `auto` selects the system language. See [language configuration](../README.md#language).

| Command           | Behavior                                                                                                         |
| ----------------- | ---------------------------------------------------------------------------------------------------------------- |
| auth              | Browser callback login; --mode apikey/token, --no-browser, --token-stdin; status/logout                          |
| config            | list/get/set; apiUrl, webUrl, space and lang                                                                     |
| ls / info         | Mixed listings, recursion, metadata and opaque revision identifiers                                              |
| mkdir             | Create directory; --parents creates ancestors                                                                    |
| new               | Empty text, --content text or --from-stdin bytes; explicit MIME currently accepts only text/plain                |
| put / get         | Raw upload/download; --force overwrites; remote overwrite appends a revision of the same type and retains the ID |
| cp                | Files and recursive directories; existing destinations cannot be overwritten                                     |
| mv                | Rename in place or move with the same name; simultaneous move and rename is unsupported                          |
| rm                | Soft deletion unavailable; --permanent --yes submits a real deletion job                                         |
| cat               | Existing UTF-8 original content only; no automatic extraction or AI interpretation                               |
| view              | Existing current-revision previews; artifact retrieval descriptors; --url prints only the viewer link            |
| find              | Metadata name glob, type and creation date filters                                                               |
| grep / seek / ask | RE2 content matching, semantic retrieval and grounded answers                                                    |
| search            | Lexical/hybrid endpoints unavailable; NOT_IMPLEMENTED                                                            |
| ws                | ls/info/use, usage/quota/balance/members, invite/remove/role, edit --name                                        |
| ops               | capabilities, convert --to pdf, render --to webp; --output creates managed files                                 |
| jobs              | status/result accept portable dfj1 handles; ls/cancel unsupported                                                |
| version           | ls and restore --to REVISION_ID; restoring creates a new revision                                                |
| pptx / docx       | capabilities; structural info unimplemented                                                                      |

`ws new/rm/stats`, workspace descriptions, answer sessions and whole-file extract/resize/crop/trim/transcribe/thumbnail are strict placeholders. Public roles are manager and teammate. Member management uses user IDs; email resolution is unsupported.

```sh
deckflow ls / --ws WORKSPACE_ID --json
deckflow mkdir /Reports --parents
deckflow put ./report.pdf /Reports/report.pdf
deckflow get /Reports/report.pdf ./downloaded.pdf
deckflow view /Reports/report.pdf --json
deckflow ops convert /Reports/report.docx --to pdf --output /Reports/export.pdf --yes
```

Listings default to 50 entries; `--limit` accepts 1–100. Continue with `--cursor`. Cursors are bound to scope and filters. Offset adaptation does not provide snapshot consistency; large directory traversals read all accessible metadata.

Plain and JSON `ls` entries retain only id, name, kind, path and available format, updatedAt and version fields. Recursive output uses the same fields. Use `info` for full metadata.

`--if-version` accepts the revision returned by info; stale revisions are not silently refreshed. `--dry-run` submits no jobs or resource writes. Permanent deletion and restoration require `--yes` or interactive confirmation. `--timeout` is positive integer seconds, default 30. `--wait-timeout` accepts a duration such as 10m, default 10m.

Retrieve previews and artifacts using returned SDK method/params or artifact IDs. Server authorization still applies; no public share is created. Processing produces backend artifacts by default. Persisting multiple render outputs requires an existing output directory; existing paths always conflict.

API key compatibility for `ws members` and `ws usage/quota/balance` depends on the server allowlist. Inspect `error.details.server_reason` for HTTP 403 to distinguish unsupported credential types from insufficient permissions. See [authentication](auth-and-workspaces.en.md#api-key-compatibility).
