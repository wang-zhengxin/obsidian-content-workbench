# 来源与许可

本项目代码采用 MIT 许可。`assets/` 来自用户指定的 Figma 文件，不纳入项目代码的 MIT 许可授权范围；对外分发设计资源前应确认其权利归属。

## 打包进插件的运行依赖

- React / React DOM：MIT，许可证位于 `licenses/react.txt`、`licenses/react-dom.txt`。
- marked：MIT，`licenses/marked.txt`。
- yaml：ISC，`licenses/yaml.txt`。
- DOMPurify：Apache-2.0 或 MPL-2.0，项目选用 Apache-2.0，`licenses/dompurify.txt`。

实际版本以 `package-lock.json` 为准。Obsidian API 是宿主提供的接口，不打包 Obsidian 应用代码。

## 研究参考

- [obsidian-kanban-action-planner](https://github.com/dsebastien/obsidian-kanban-action-planner/tree/04ba370be0ba9a06ae4e26193fcb3e7e85a01406)，MIT，快照 `04ba370`。参考 5px 拖拽阈值、浮动副本、落点线、自动滚动和过渡节奏；本插件的拖拽控制器是针对自身数据模型编写的实现。
- [obsidian-wechat-converter](https://github.com/DavidLam-oss/obsidian-wechat-converter/tree/3fef6122d07f405cc4459102d0545551c7bc50bb)，MIT，快照 `3fef612`。参考素材上传、草稿关联和创建/更新流程。
- [Wechatsync](https://github.com/wechatsync/Wechatsync)，作为平台适配研究背景，未集成其浏览器扩展或驱动代码。
- [用户提供的 Figma](https://www.figma.com/design/PhfAPIXr1FvFWWN4kkCFw9/Untitled?node-id=2-4255)：布局、颜色、图标与图谱静态图形的来源。随仓库提供已导出的本地资源，名称映射见 `src/asset-map.json`；构建时不依赖临时 Figma 下载地址。
