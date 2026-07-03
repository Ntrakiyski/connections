# OpenConnector

[English](README.md) | [简体中文](README.zh-CN.md)

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE.txt)
![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-339933)
![Cloudflare compatible](https://img.shields.io/badge/Cloudflare-compatible-F38020)
![MCP](https://img.shields.io/badge/MCP-ready-111827)
![OpenAPI](https://img.shields.io/badge/OpenAPI-3.1-6BA539)

[![Dynamic JSON Badge](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fconnector.oomol.com%2Fv1%2Fcatalog&query=data.providerCount&label=Providers&color=%237d7fe9)](https://oomol.com/apps)
[![Dynamic JSON Badge](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fconnector.oomol.com%2Fv1%2Fcatalog&query=data.actionCount&label=Actions&color=%237d7fe9)](https://oomol.com/apps)

OpenConnector 是一个开源鉴权网关，连接了 800+ 个 provider，兼容 Cloudflare 部署，并通过
[Connector SDK](https://github.com/oomol-lab/connector-sdk)、[oo CLI](https://github.com/oomol-lab/oo-cli)、MCP 和 HTTP 为 AI Agent 提供 6,680 个可直接调用的预置 Action。

OpenConnector 不只是保存 provider 凭据。它把 Gateway、provider catalog 和 Action executors
都开源出来，让开发者可以自托管运行时、检查每个 Action 契约，并以可控方式让 Agent 调用真实 SaaS，
而不是从零重复封装每一家 API。

## 为什么选择 OpenConnector

- [连接 800+ 个 provider，提供 8000+ 个预置 Action](docs/providers.md)，覆盖 GitHub、Gmail、Notion、
  BigQuery、Google Analytics、Supabase、Airtable、Slack 等常见 SaaS。
- 开源鉴权网关，统一管理 API key、OAuth2、自定义凭据和无需鉴权的 provider。
- 开源 Action 层，内置请求/响应 schema 和按需加载的 executor。
- 兼容 Cloudflare 部署，支持 Workers、D1、R2 和 Static Assets。
- 面向 Agent 的调用入口，支持 [Connector SDK](https://github.com/oomol-lab/connector-sdk)、
  [oo CLI](https://github.com/oomol-lab/oo-cli)、MCP、HTTP API、OpenAPI 和本地 Web 控制台。
- 运行时控制能力包括连接身份、scope、runtime token、action allow/block policy、临时文件中转和脱敏运行日志。

## 开发者工具

| 工具                                                        | 用途                                                                                     |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| [Connector SDK](https://github.com/oomol-lab/connector-sdk) | 在 TypeScript 应用和 Agent runtime 中调用 connector Action、代理上游 API、读取 catalog。 |
| [oo CLI](https://github.com/oomol-lab/oo-cli)               | 为本地 AI Agent 提供命令行入口，用来发现、查看和调用已连接账号的能力。                   |
| MCP                                                         | 通过 `http://localhost:3000/mcp` 把应用 Action 暴露给支持 MCP 的 agent host。            |
| HTTP / OpenAPI                                              | 直接调用 `/v1/actions/*`，或查看生成的 `/openapi.json` 文档。                            |

## 连入 SaaS Logo 墙

OpenConnector 当前支持 800+ 个 provider 和 8000+ 个预置 Action。下面的 logo 墙只是部分展示，不代表完整 catalog。它选取了一组高识别度的 SaaS、开发者工具、效率应用、数据分析产品和 AI 服务，让用户一眼感受到 OpenConnector 覆盖的范围远不止这些 logo。

![连入 SaaS Logo 墙](assets/saas-logo-wall.png)

Provider 名称和商标归各自权利人所有，本项目仅用于识别服务和实现互操作。

## 工作方式

```mermaid
flowchart LR
  Agent["AI Agent / App"] -->|"SDK / CLI / MCP / HTTP"| Gateway["OpenConnector Gateway"]
  Gateway --> Auth["Credential & OAuth Boundary"]
  Gateway --> Catalog["Provider Catalog"]
  Gateway --> Actions["Open-source Action Executors"]
  Gateway --> Policy["Tokens, Scopes, Allow/Block Policy"]
  Gateway --> Logs["Run Logs"]
  Actions --> SaaS["643 Providers"]
  Console["Web Console"] --> Gateway
  Cloudflare["Cloudflare Workers, D1, R2"] -. deploy .-> Gateway
```

Agent 可以发现 Action、查看 schema 和 scope、选择 connection alias，并通过网关执行调用。Provider
secret 保留在运行时边界内；Agent 只拿到所需的 metadata、安全账号标签和执行结果。

## 使用路径

| 路径                        | 适合谁                                | 提供什么                                                                   |
| --------------------------- | ------------------------------------- | -------------------------------------------------------------------------- |
| OSS Self-host               | 想完全掌控基础设施的开发者和团队      | 本地 Docker 或 Node runtime、SQLite 存储、MCP、HTTP、OpenAPI 和 Web 控制台 |
| Cloudflare 兼容部署         | 想快速拥有轻量托管运行时的团队        | Workers runtime、D1 状态存储、R2 文件中转和控制台 Static Assets            |
| [oomol](https://oomol.com/) | 被 OAuth 申请周期或上线时间卡住的团队 | 托管鉴权和运行时路径，并保留后续迁移到私有化或自托管部署的空间             |

## Cloudflare 快速启动视频

即将补充：一个 YouTube 视频，用来演示如何基于 Cloudflare 快速启动可用版 OpenConnector。

## 快速开始

使用 Docker Compose 启动运行时：

```bash
docker compose up --build
```

打开本地控制台和生成的 API 文档：

```text
http://localhost:3000
http://localhost:3000/docs
```

运行一个不需要鉴权的 Action，确认运行时已经正常工作：

```bash
curl -s -X POST http://localhost:3000/v1/actions/hackernews.get_top_stories \
  -H 'content-type: application/json' \
  -d '{"input":{}}'
```

完整本地启动、第一个 provider 连接、OAuth flow 和运行时设置见 [docs/quickstart.md](docs/quickstart.md)。

## 连接 Provider

GitHub 是最简单的带凭据示例，因为它可以使用 personal access token：

```bash
curl -s -X PUT http://localhost:3000/api/connections/github \
  -H 'content-type: application/json' \
  -d '{"authType":"api_key","values":{"apiKey":"github_pat_..."}}'

curl -s -X POST http://localhost:3000/v1/actions/github.get_current_user \
  -H 'content-type: application/json' \
  -d '{"input":{}}'
```

OAuth2 应用、命名连接、凭据加密、token 刷新和 action policy 见
[docs/credentials.md](docs/credentials.md) 与 [docs/configuration.md](docs/configuration.md)。

## 给 Agent 使用工具

OpenConnector 通过多个面向 Agent 的入口暴露同一份 Action catalog：

- MCP：`http://localhost:3000/mcp`
- HTTP runtime API：`/v1/actions`
- OpenAPI 文档：`/openapi.json`
- Action guide：`/api/actions/:actionId/agent.md`
- Web 控制台示例：每个 Action 都可以复制 cURL、TypeScript 和 agent prompt 示例

Endpoint、response envelope、鉴权 header、MCP tools 和 Action guide 示例见
[docs/runtime-api.md](docs/runtime-api.md)。

## Web 控制台

启动运行时后打开 `http://localhost:3000`。控制台可以帮助你浏览 provider、保存 API key 或 OAuth
client 配置、创建 runtime token、查看 Action schema、调试 Action、查看最近运行记录，并打开生成的
OpenAPI 和 MCP metadata。

## Cloudflare 部署

OpenConnector 支持使用 Cloudflare Workers 作为 metadata 和运行时状态部署目标，配套使用 Workers、
D1、R2 和 Static Assets。

Cloudflare 资源创建、migration、secret、本地 Worker preview 和远程部署步骤见
[docs/cloudflare.md](docs/cloudflare.md)。

## oomol 和 Wanta

OpenConnector 是面向自托管和可控运行时的开源网关。

如果业务需要马上上线，[oomol](https://oomol.com/) 提供 SaaS 版：先使用托管鉴权和运行时基础设施，并保留后续迁移到私有化或自托管部署的空间。

针对希望直接使用桌面端 Agent 的小团队或个人，[Wanta](https://wanta.ai/)
通过桌面端产品体验连接应用，并额外提供团队应用共享、权限控制、多账号连接、按 workspace 隔离连接等能力。

## 文档

- [快速开始](docs/quickstart.md)
- [开发者工具](docs/sdk-cli.md)
- [Provider 覆盖](docs/providers.md)
- [Runtime API 和 MCP](docs/runtime-api.md)
- [Cloudflare 部署](docs/cloudflare.md)
- [配置项](docs/configuration.md)
- [凭据和 OAuth](docs/credentials.md)
- [Catalog 格式](docs/catalog-format.md)
- [Verification 语言](docs/verification.md)
- [贡献指南](CONTRIBUTING.md)
- [行为准则](CODE_OF_CONDUCT.md)
- [安全政策](SECURITY.md)

## 开发

请使用 Node.js 22 或更新版本：

```bash
npm install
npm run build:web
npm run dev
```

打开 pull request 前运行：

```bash
npm run fix-check
npm test
```

Provider 代码位于 `src/providers/<service>`。Provider 贡献规则见
[CONTRIBUTING.md](CONTRIBUTING.md#adding-providers)。

## 许可证范围

除非另有说明，本仓库中的源代码、脚本、生成的项目脚手架、测试和文档均基于 Apache License, Version
2.0 授权。见 [LICENSE.txt](LICENSE.txt)。

本仓库的 Apache-2.0 许可证不授予任何第三方产品、provider、app、API、商标、服务标识、商号、logo、
icon、品牌资产、文档、截图或其它归属于相应权利人的版权材料的使用权。

Provider 和 app 名称、metadata、链接、scope、permission 以及可选 logo/icon 仅用于识别服务和实现互操作。
所有第三方品牌和产品权利仍归各自权利人所有。本 catalog 中出现某个服务不代表其权利人对本项目的认可、赞助、合作、认证或验证。

如果你贡献 provider metadata 或资产，请只提交你有权提交的材料。优先链接到官方公开资产，而不是把品牌文件复制到本仓库。

## 社区

请让 issue 和 pull request 保持聚焦、尊重且可执行。参与本项目需遵守 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。
