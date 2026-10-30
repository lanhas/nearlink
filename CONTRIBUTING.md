# 贡献

使用 Node.js 22.19+、npm 与 TypeScript。运行 `npm ci` 和 `npm run dev`。

提交前执行 `npm run build`、`npm test`，界面/IPC 变化再执行 `npm run smoke`。新增联网能力应保持免云端、本地存储与有限内存使用的原则。不要引入远端脚本、任意路径 IPC、关闭渲染沙箱或将整个文件读入内存。

数据库变更需要增加模式版本并提供迁移；协议不兼容变化需要增加发现和 hello 中的版本号。更改群成员规则时同时覆盖网络鉴权与离线补发。

请只提交源码、锁文件、最终图标和适当的文档。不要提交 `.smoke`、`release`、SQLite 数据、证书私钥或用户聊天。
