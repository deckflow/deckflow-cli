# Authentication and workspaces

[中文](auth-and-workspaces.md) | **English**

Credentials remain at `~/.deckflow/credentials`, mode 0600, bound to the API endpoint. Existing default workspaces are preserved. API keys do not appear in normal diagnostics. The same user configuration stores `lang`; login/logout retain it.

```sh
deckflow config set apiUrl https://deckbase.example.com/api
deckflow config set webUrl https://deckbase.example.com
deckflow auth login
deckflow ws ls
deckflow ws use WORKSPACE_ID
```

`--ws` is optional after saving a default with `ws use`. A temporary override does not modify saved settings. Missing every source produces `WORKSPACE_REQUIRED`. Precedence: `--ws` → `DECKFLOW_WORKSPACE` → user default. Legacy `--space`, `DECKFLOW_SPACE`, `.deckflow.json` and `space use --local` are removed. Display names are not slugs; APIs use stable workspace IDs.

## Browser login, accounts and migration

```sh
deckflow auth login
deckflow auth login --no-browser
cat /secure/path/key | deckflow auth login --with-token
deckflow auth accounts
deckflow auth switch --user ACCOUNT_ID
deckflow auth status --json
deckflow auth logout --revoke
```

Browser login requires one confirmation and issues a dedicated CLI token for workspace read/write, valid for 30 days. The authorization page identifies the account and scope. Actual permissions remain bounded by live workspace roles. Expired or revoked tokens require a fresh login; there is no implicit renewal and the browser session remains independent. Default logout removes the local active account only; `--revoke` first revokes its token. Manage API-key revocation in the WebUI. Imported legacy tokens retain their issuer's lifetime and revocation semantics.

`--with-token` explicitly imports an existing API key or compatible token from stdin; `--token-stdin` remains an alias. `--mode` is deprecated: token warns and uses dedicated authorization; apikey warns and fails with migration instructions rather than silently changing credential type or permissions. Migrate old scripts to `--with-token`. Deploy the matching DeckBase and authorization page: browser login rejects older responses that share browser tokens.

Business commands and status prefer `DECKFLOW_TOKEN` over the local active account. The environment token is never implicitly persisted; login and switch refuse to modify credentials while it overrides the environment. Unset it to restore the local active account. Status displays the effective account, API instance, source and available expiry, without secrets. Accounts are stored per API instance in the mode-0600 credentials file; legacy single-account credentials and other configuration survive migration. Switching on API A does not change API B.

The CLI validates state and Host on a random loopback callback and exchanges after confirmation without polling. `--no-browser` prints the link. Interruptions, timeouts and failures preserve prior active credentials and close the listener. Remote terminals can forward the callback port or import via stdin. Expiry and read-only workspace denials remain distinct and never bypass server authorization.
