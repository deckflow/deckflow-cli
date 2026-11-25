# v0.3 迁移与能力缺口

**中文** | [English](migration-v03.en.md)

未设置语言的现有用户将自动读取系统语言。使用 `deckflow config set lang zh` 固定中文，`en` 固定英文，`auto` 恢复自动检测；凭据和默认空间均保留。

本次直接切换命令契约，不提供旧业务别名。登录凭据及用户默认空间保留。

## 从旧 npm 包迁移

旧包 `@deckflow/cli` 和新包 `@deckflow/deckflow-cli` 都提供全局命令 `deckflow`。在同一 npm global prefix 中直接安装新包可能报 `EEXIST`；先卸载旧包，再安装新包：

```sh
npm uninstall -g @deckflow/cli
npm install -g @deckflow/deckflow-cli --registry=https://registry.npmjs.org
deckflow --version
```

两步应使用同一个 Node/npm 环境及 global prefix。无需删除 `~/.deckflow/credentials`；包卸载和凭据清理是独立操作。

| 旧入口                         | 新入口                                      |
| ------------------------------ | ------------------------------------------- |
| space list/get/use             | ws ls/info/use                              |
| file list/get、folder list/get | ls/info                                     |
| upload / download              | put LOCAL DEST / get SOURCE LOCAL           |
| folder create                  | mkdir PATH                                  |
| file move/update --name        | mv SOURCE DEST                              |
| file delete、folder delete     | rm TARGET --permanent（默认软删除尚未支持） |
| file convert                   | ops convert；默认不创建受管文件             |
| revision list/restore          | version ls/restore                          |
| usage                          | ws usage/quota/balance                      |
| open 文件                      | view FILE --url                             |

share/album/api/action 等旧业务入口已移除。`--space` 改为 `--ws`，`DECKFLOW_SPACE` 改为 `DECKFLOW_WORKSPACE`，timeout 改为整数秒。JSON 失败从 stderr 移到 stdout，并使用 ok/error/meta envelope；旧退出码映射不再适用。

后端后续工作：回收站；原子覆盖及移动并改名；跨文件目录名称唯一约束；空间 slug/创建/删除/统计；lexical/hybrid 控制；问答会话；完整缓存文本接口；任务列表及取消；媒体处理和结构化 Office API。

当前 SDK 源生成存在上游 embed.query 类型问题；本地适配使用已有 dist-sdk，方法清单从实际安装 SDK 的运行时和声明交集生成。升级 SDK 时必须重新运行 contracts/typecheck/test/pack:check。不得跳过类型检查发布。
