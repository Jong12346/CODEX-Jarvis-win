# sherpa-onnx 浏览器唤醒资产

本目录只保留接入说明，WASM 与模型二进制默认被 `.gitignore` 排除。浏览器联调页只有检测到 `sherpa-kws-manifest.json` 后才开放“启用唤醒”，缺少资产时仍可手动开始豆包实时对话。

## 需要放入的文件

1. 按 sherpa-onnx 官方 `wasm/kws` 示例构建 WebAssembly KWS。
2. 将构建结果中的 `sherpa-onnx-kws.js`、`sherpa-onnx-wasm-kws-main.js`、`.wasm`、`.data` 及其模型文件放入本目录。
3. 复制 `sherpa-kws-manifest.example.json` 为 `sherpa-kws-manifest.json`，并按实际构建产物填写脚本、模型文件和关键词 token 序列。
4. 关键词 token 必须来自所选模型的 `tokens.txt`；不要把示例中的占位文本直接用于验收。

官方 SIMD/线程版 WASM 需要页面返回 `Cross-Origin-Opener-Policy: same-origin` 与 `Cross-Origin-Embedder-Policy: require-corp`。当前 PoC 的 Vite 服务已经设置这两个响应头；迁移到 DSH Web 宿主时也必须保留。

正式分发前需把模型来源、版本、许可证和 SHA-256 写入发布文档。当前仓库不代为下载或重新分发模型。
