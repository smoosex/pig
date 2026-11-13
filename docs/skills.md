# Skills 的来源、导入与更新

修改 Skills 设置、资源发现、导入、更新或会话重载前阅读。

## 来源、存储与更新边界

- Skills 设置页分「已安装 / 发现」。
- 个人 Pi 配置与 `~/.agents/skills` 自动发现的文件只读，启停仅写 Pig 的 `skills.json`，不修改共享目录。
- 本地导入仅在 `skills.json` 登记原 Skill 目录（`localPath`），直接加载，不复制也不创建软链接，移除只取消登记、绝不删除源目录。
- GitHub 导入先按不可变 commit 探测 `SKILL.md` 再多选复制到 `$PIG_DIR/skills/<uuid>/<name>/`，记录 `remote` 的 commit、ref、仓库内 manifest 路径与整目录 SHA-256 fingerprint，不执行仓库代码，不走 Pi package 安装。
- 远程支持手动检查／更新，不静默更新；更新先下载完整新版本并验证，替换前再次检查本地修改（含文件、可执行位及链接），有冲突直接拒绝。
- 下载与注册表临时文件写好后，IPC 传入的同步守卫在替换前再次检查会话空闲；守卫、目录 swap 与注册表 rename 同一同步段完成，任务启动不能穿插，注册表提交失败同样同步恢复旧目录并重抛 IO 错误。
- 稳定路径不变，旧版本与移除的副本留在 `skill-backups/`。
- 没有 `localPath`／`remote` 的旧快照保持不变，不推断或自动迁移来源；重新安装才获得引用或更新能力。
- `chat-resources.ts` 的两个 loader 都通过 `applySkillPreferences` 动态合并副本与过滤禁用项；会话清单与实际加载共用按真实路径去重后的选择，Pi／项目优先于导入项，导入引用优先于同路径的其他 Agent 发现项（引用关闭时也不借后者绕开启用）；Chat 仍排除项目 Skills，空闲会话自动重载，运行中的会话延后到任务结束。
- 另外会扫描 `~/.claude/skills` 与 `~/.codex/skills`（遵循 `CLAUDE_CONFIG_DIR` / `CODEX_HOME`，跳过 `.system` 等隐藏目录），它们不是 Pi 的来源，所以默认关闭，启用状态记在 `skills.json` 的 `enabledPaths`，由 `applySkillPreferences` 按原路径直接加载（不复制，Chat 也生效）；这类 Skill 不占用安装时的同名检查。
- 全局清单不依赖项目目录，也不解析或加载用户配置的 packages。
