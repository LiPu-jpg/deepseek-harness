---
kind: upgrade-guide
description: Desktop 插件包写入要求完全退出应用。
---
# Desktop 插件更新要求退出应用

[English](guide.md) | 中文

## 变更

通过 `dsh plugin --profile desktop` 写入 Desktop 包时，正在运行或无法检查的应用会被拒绝。安装先在完整 profile 副本中完成，再替换依赖。包查询仍然可用。链接的 profile 根目录、链接的依赖根目录及外部虚拟存储必须先改用实体 profile，才能执行包写操作。CLI 的 stdout 和 stderr 会转发并保留在 `pnpm.log`，不再绕过诊断捕获。

## 迁移

1. 完全退出 DeepSeek Harness Desktop，包括后台外壳进程。
2. 使用 Desktop 自带的 `dsh plugin --profile desktop add <package>` 或其他包写入命令。命令返回前保持 Desktop 关闭。
3. 重新打开 Desktop。启动准备会在加载插件前恢复中断的目录替换。若恢复报告后续 manifest 变更，应保留日志和旧目录用于人工恢复，不要删除它们。
4. 安装失败时检查报告的诊断路径；提交前正式依赖树保持不变。
