# v0.3 migration and capability gaps

[中文](migration-v03.md) | **English**

The command contract changes directly, without legacy business aliases. Login credentials and the user default workspace are preserved. Existing users receive automatic system language detection unless they save `lang`; use `deckflow config set lang zh` to retain Chinese or `en` for English. `auto` restores automatic detection.

## Migrating from the old npm package

Both `@deckflow/cli` and `@deckflow/deckflow-cli` provide the global `deckflow` command. Installing over the old package in the same global prefix may produce `EEXIST`. Uninstall it first:

```sh
npm uninstall -g @deckflow/cli
npm install -g @deckflow/deckflow-cli --registry=https://registry.npmjs.org
deckflow --version
```

Use the same Node/npm environment and global prefix. Do not delete `~/.deckflow/credentials`; uninstalling packages does not require credential cleanup.

| Old command                    | New command                                      |
| ------------------------------ | ------------------------------------------------ |
| space list/get/use             | ws ls/info/use                                   |
| file list/get, folder list/get | ls/info                                          |
| upload / download              | put LOCAL DEST / get SOURCE LOCAL                |
| folder create                  | mkdir PATH                                       |
| file move/update --name        | mv SOURCE DEST                                   |
| file delete, folder delete     | rm TARGET --permanent; soft deletion unavailable |
| file convert                   | ops convert; no managed file by default          |
| revision list/restore          | version ls/restore                               |
| usage                          | ws usage/quota/balance                           |
| open file                      | view FILE --url                                  |

Legacy share/album/api/action commands are removed. `--space` becomes `--ws`; `DECKFLOW_SPACE` becomes `DECKFLOW_WORKSPACE`; timeout accepts integer seconds. JSON failures move from stderr to stdout with an ok/error/meta envelope. Old exit mappings no longer apply.

Future backend work: trash; atomic overwrite and simultaneous move/rename; cross-file/folder unique names; workspace slugs, creation, deletion and statistics; lexical/hybrid controls; answer sessions; complete cached text APIs; job listing/cancellation; media processing and structured Office APIs.

SDK source generation currently has an upstream embed.query type issue. Local adaptation uses existing dist-sdk; the method manifest is generated from installed SDK runtime/declaration intersections. After upgrades run contracts/typecheck/test/pack:check. Never skip typechecking when publishing.
