# GitHub to GitLab Synchronizer

基于 TypeScript + [`tsdown`](https://github.com/sxzz/tsdown) 构建的 GitHub 数据导出包全量迁移到 GitLab 工具。

## 功能特性

- **环境变量驱动**：自动读取 `.env` 中的 `GITLAB_TOKEN` 与目标命名空间。
- **tsdown 极速打包构建**：基于 `tsdown` (Rolldown 内核) 进行秒级编译与执行。
- **全量仓库同步**：自动在 GitLab 对应命名空间创建项目并同步公开/私有属性、分支、标签。
- **版本发布与工单**：支持 Releases 发布版本说明与 Issues 的无缝迁移。
- **超限与边界处理**：自动处理特殊命名路径限制及历史大文件（如超限二进制包）过滤保护。

## 使用方法

1. 配置 `.env`：
   ```env
   GITLAB_TOKEN=your_gitlab_token_here
   ```

2. 安装依赖并运行：
   ```bash
   pnpm install
   pnpm start # 使用 tsdown 构建并执行
   ```
