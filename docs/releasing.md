# 发布

每个版本以 Git tag 为来源。版本号必须与 `package.json` 一致，例如 `v0.1.0`。

```bash
npm ci
npm run build
npm test
npm run smoke
```

确认更改已经提交且工作区干净，然后：

```bash
npm run release
```

该脚本验证仓库、主分支、干净状态和版本，创建附注 tag 并推送。GitHub Actions 在原生 macOS 和 Windows runner 上重新执行构建、核心测试和 Electron UI 测试，再生成：

- `Nearlink-mac-arm64.dmg`
- `Nearlink-mac-arm64.zip`
- `Nearlink-win-x64-setup.exe`
- `Nearlink-win-x64-portable.exe`
- `SHA256SUMS.txt`

两个平台都成功后才创建 GitHub Release。README 使用 latest/download 稳定文件名，不需要随版本修改下载链接。单个平台失败不会发布不完整的版本。

当前 macOS 采用 ad-hoc 签名，没有 Developer ID 公证；Windows 未配置商业证书。未来加入签名时，在 GitHub Actions Secrets 配置证书及公证凭据，更新 electron-builder 配置；不能把私钥提交到仓库。

图标来源是 `resources/icon.svg`。`npm run icons` 在任意平台生成 PNG、ICO、ICNS；生成的最终应用图标提交到仓库，不需要在 CI 装系统图形工具。
