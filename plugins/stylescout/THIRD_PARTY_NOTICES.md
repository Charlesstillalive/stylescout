# THIRD_PARTY_NOTICES — dsh-plugin-style-scout（采风 StyleScout）

本插件在开发中参考了同 workspace `refs/` 下的开源插件，以及 OpenDesign 的 schema 思路。

**它们都不是运行时依赖**：`dsh-plugin-style-scout` 不 import 这些包、不假设它们已安装；
本公开独立版使用 Node.js 内置模块和本机 Chrome/Edge，不包含旧 DSH 宿主适配或 React 客户端。以下保留开发参考来源记录；这些声明不构成本项目整体的开源授权。

## 参考来源

| 来源 | 版本 | 许可 | 复用内容 | 代码是否已复制 |
|---|---|---|---|---|
| `refs/dsh-ui-spec`（https://github.com/yumimanji/dsh-ui-spec） | 0.1.1 | MIT | tool 注册写法、受管浏览器 / CDP 生命周期、截图→规范证据 schema（M-3 起复用） | 否（M-1 仅参考模式） |
| `refs/dsh-design-studio`（https://github.com/YansongG-HKU/dsh-design-studio） | 1.3.1 | MIT | client 面板结构、资产存储与索引、导出格式、主题 token 结构（M-2 起复用） | 否（M-1 仅参考模式） |
| `refs/Perfect-Web-Clone`（https://github.com/ericshang98/Perfect-Web-Clone） | 3.0.0 | MIT | capture 流程、资产本地化、视觉打分思路（M-3 起复用） | 否（M-1 仅参考模式） |
| OpenDesign / Web Clipper（https://github.com/OpenDesign） | — | Apache-2.0 | `design-dna` schema 的字段组织思路（仅概念参考） | 否 |

## 复制代码时的规矩

1. 代码放进 `lib/vendor/<source>/`，保留原文件头的版权声明；
2. 在本文件"代码是否已复制"列更新为"是"，并写清文件路径；
3. 如复制 Apache-2.0 代码，同时保留其 `NOTICE`（若原项目提供）。

## 许可文本（MIT）

MIT License

Copyright (c) 2026 yumimanji — dsh-ui-spec
Copyright (c) 2026 YansongG-HKU — dsh-design-studio
Copyright (c) 2024 Nexting.ai — Perfect-Web-Clone

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
