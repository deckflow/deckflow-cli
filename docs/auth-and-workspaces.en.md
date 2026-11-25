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

## Browser authorization

```sh
deckflow auth login               # Default API key; choose Token on the web
deckflow auth login --mode apikey # Also accepts apiKey
deckflow auth login --mode token
deckflow auth login --no-browser  # Open the link manually on this machine
```

Configure both API and Web endpoints. Non-local endpoints require HTTPS. The CLI listens on `127.0.0.1` at a random port for `/callback` and binds random state to the request. The browser redirects after approval or denial. The CLI validates Host and state, then calls `cliAuth.exchange` once; it does not poll for authorization. Credentials appear only in the API response, never callback URLs, terminal output or JSON. Network and rate limit failures have bounded retries respecting Retry-After.

The web defaults to a read-only API key without expiry. Users can select write permissions and expiry and manage keys at `/account/keys`. Token mode reuses the web session; logout, session cleanup and expiration can affect the CLI.

Ctrl+C, SIGTERM and timeout cancel the handoff and close the local listener. `--wait-timeout` defaults to 10m. Failure preserves previous credentials and workspace; success atomically replaces credentials. The browser must reach the CLI machine's loopback. Remote terminals can forward the port or import credentials with `--token-stdin`.

Deploy the callback-capable DeckBase API and WebUI first. Legacy device polling remains available to other clients.

`DECKFLOW_API_URL/DECKFLOW_WEB_URL` override configuration; `DECKFLOW_TOKEN` overrides stored credentials. With that variable set, login without explicit `--mode` imports it; explicit `--mode` starts browser authorization. `--mode` and `--token-stdin` are mutually exclusive. Logout removes local credentials only; it neither revokes remote API keys nor clears environment variables.

There is one CLI user configuration. `config set space ID` also saves a default, while `ws use ID` is the recommended entry. Operation state uses `XDG_CONFIG_HOME/deckflow/operations` or `~/.config/deckflow/operations`.

Language can be changed without authentication using `config set lang en`, `zh` or `auto`. `--lang` and `DECKFLOW_LANG` temporarily override it. The local callback follows this language; the authorization website uses its own language preference.

## API key compatibility

Workspace roles such as leader do not imply that an API key can call every endpoint. `ws members` uses `space.users`; usage/quota/balance use `billing.detail`. API key support depends on the deployed server allowlist. A key may work for `ws info` and fail for these endpoints.

For HTTP 403, inspect `error.details.server_reason`. `API key is not allowed for this method` means the endpoint rejects this credential type. Other authorization failures require checking account permissions or key scope. Changing workspace roles does not bypass endpoint credential restrictions. Original server reasons are preserved.
