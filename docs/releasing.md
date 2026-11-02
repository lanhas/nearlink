# 发布

版本号必须与 `package.json` 一致，例如 `v0.1.2`。发布以 Git tag 或主分支的完整提交号为来源。

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

该脚本验证仓库、主分支、干净状态和版本，创建附注 tag 并推送。也可在主分支手动运行 Release 工作流并选择 `publish=true`，先验证，成功后由发布任务为对应提交创建 tag。默认手动运行只验证、不发布。

GitHub Actions 在原生 macOS 和 Windows runner 上重新执行构建、核心测试和 Electron UI 测试，再生成安装包，并验证打包应用的实际更新和重启：

- `Nearlink-mac-arm64.dmg`
- `Nearlink-mac-arm64.zip`
- `Nearlink-win-x64-setup.exe`
- `Nearlink-win-x64-portable.exe`
- `SHA256SUMS.txt`
- `update.json` 与 `update.json.sig`

两个平台都成功后才创建 GitHub Release。README 使用 latest/download 稳定文件名，不需要随版本修改下载链接。单个平台失败不会发布不完整的版本。

更新清单由发布步骤使用仓库 Secret `NEARLINK_UPDATE_PRIVATE_KEY` 进行 Ed25519 签名，客户端公钥位于 `resources/update-public-key.pem`。发布脚本验证公私钥匹配；签名失败或密钥缺失时不发布。私钥不能提交到 Git，本地备份目录 `.release-secrets/` 已忽略。已有客户端依赖当前公钥，不要随意替换密钥。每个版本必须提供对应的 `docs/releases/v版本号.md`。

当前 macOS 采用 ad-hoc 签名，没有 Developer ID 公证；Windows 未配置商业证书。未来加入签名时，在 GitHub Actions Secrets 配置证书及公证凭据，更新 electron-builder 配置；不能把私钥提交到仓库。

图标来源是 `resources/icon.svg`。`npm run icons` 在任意平台生成 PNG、ICO、ICNS；生成的最终应用图标提交到仓库，不需要在 CI 装系统图形工具。
