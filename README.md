# deepsky-motion · 深空影像推进工作室

把**一张深空天文照片**变成一段**带 3D 景深推进感的视频**，并导出成**实况图**（Live Photo / Motion Photo / 动态 WebP）。

纯本地运行。不上传云端，不联网，不埋点。所有解码、分析、渲染、编码都在你自己的机器上完成。

```
┌─────────────┐   ┌──────────────┐   ┌────────────────┐   ┌──────────────┐
│ 上传深空照片 │ → │ 星点检测 +   │ → │ 星点分层渲染   │ → │ MP4 / 实况图 │
│ PNG/JPG/FITS│   │ 深度分配     │   │ 相机推进       │   │ 动态 WebP    │
└─────────────┘   └──────────────┘   └────────────────┘   └──────────────┘
```

---

## 快速开始

```bash
cd deepsky-motion
pnpm install          # 只有一个依赖：sharp
pnpm start            # 默认 http://127.0.0.1:8765
```

浏览器打开 <http://127.0.0.1:8765>，点 **示例** 按钮即可加载内置星云样片，无需自备素材。

分析后显示原图。选择参数和输出格式，点击 **生成准确预览**，等待最终文件编码及预览准备完成。
预览支持暂停、拖动和重播，使用所选格式实际的尺寸、帧数和时长；动图的压缩、调色板与降帧也会体现在预览中。
修改参数或格式后需手动重新生成。点击 **导出当前结果** 直接下载已预览的同一份产物，不会再次编码。
Live Photo 预览播放包内动态视频，导入 Apple 照片图库仍需转换工具。

端口被占用时：

```bash
PORT=8899 pnpm start
```

### 环境要求

| 组件 | 用途 | 必需 |
|---|---|---|
| Node.js ≥ 20 | 服务端 | ✅ |
| ffmpeg / ffprobe | MP4 / APNG / GIF 编码 | ✅ |
| img2webp | 动态 WebP（实况图主力格式） | 推荐；缺失时自动回退到 sharp |
| sips | macOS 上生成 Live Photo 的 HEIC 静帧 | 仅 macOS，缺失时回退为 JPEG |

启动时会打印检测结果：

```
  deepsky-motion · 深空影像推进工作室
  ➜  http://127.0.0.1:8765
  ffmpeg:ok  img2webp:ok  sips:ok
```

---

## 它到底做了什么

### 1. 星点检测（`server/lib/astro.mjs`）

深空照片里星点数量多、亮度跨度大，而且**亮星的衍射星芒会和邻居的星芒连成一片**。
天真的做法（阈值 + 连通域 + "太大就丢掉"）会把最亮的那几颗星整个扔掉——
结果就是"除了亮星以外全都检测到了"，而这恰恰是 3D 效果最需要的那几颗。

这里改用**局部极大值**检测：

- 以局部天光为基准做阈值（`backgroundModel` 用分块中值网格 + 残差 MAD 估噪），
  这样落在星云上的星点不会被星云本身抬高的背景淹没；
- 在 4.5σ 候选像素里找局部极大值。星芒是**细脊**，一条脊上最多出一两个极大值；
  星核是**单峰**。这一步天然把星核和星芒分开，谁都不用丢；
- 用抛物线拟合做亚像素质心refine；
- 用 `峰值 / 窗口均值` 做**形状判据**剔除星云纹理。这个判据是尺度无关的，
  同一套阈值对欠采样（FWHM≈1px）和良好采样（FWHM≈5px）的图都成立。

实测：`samples/nebula-1600.png` 检出 **1250 颗**可信星点，耗时 ~0.7s。
（阈值可调：`ANALYSIS.minSnr`。调低会引入噪声峰，画面会变成"雪花"。）

### 2. 深度分配（`assignDepth`）

每颗星得到一个 `z ∈ [0,1]`，`0` 最近、`1` 最远：

- 亮度 → 深度的单调映射（`z = lerp(zNear, zFar, mag^power)`）；
- 另外有约 10% 的星被**特意放到星云前方**。这一步很关键：只有当星场**跨越**星云平面时，
  推进时才会出现真正的视差剪切，而不是"整张图一起放大"。

### 3. 星点分离（`buildStarless`）

要让星云和星场以**不同速度**运动，必须先把星点从照片里拿掉。
难点在于亮星的**光晕会延伸 40–90px**，比星核大一个数量级；只挖星核会留下一个"鬼影"，
而这个鬼影因为跟着星云动、和它自己的星点分离，穿帮得非常明显。

做法：

1. 按亮度分级挖洞——最亮的一批星按**实测光晕半径**挖，暗星只挖星核。
   （1600×1067 的图有 2200 颗星，如果每颗都按光晕半径挖，掩膜面积会超过整张图。）
2. 用 **push-pull 金字塔**填洞：上行时只对**未被掩膜**的像素做加权平均，
   所以再大的洞也不会把星光平均进来；下行时用粗层插值填回洞内。
3. 再做几轮**残差清理**：在结果里找"又亮又紧凑"的东西，单独填掉。

这样填出来的星云是**接缝处连续的**，而且不会被"减掉"（直接做径向轮廓相减会把星云啃出暗环）。

### 4. 相机与渲染（`server/lib/render.mjs`）

3D 感来自四个叠加的线索：

| 线索 | 实现 |
|---|---|
| **差速缩放** | 每颗星绕画面中心按 `zoom(z,k) = 1 + k·dolly·parallax·depthFactor(z)` 缩放。近星（z=0）约 1.55×，远星（z=1）约 0.28×，星云在它自己的平面上 |
| **手持漂移** | 一个低频摆动，按 `(1-z)` 加权作用到每颗星上——即使还没开始推近，近星也已经比远星"晃得多" |
| **逆平方增亮** | 相机推近时星点按 `zoom^1.45` 变亮 |
| **遮挡** | 位于星云之后的星，在星云亮的地方会被压暗 |
| **景深** | 可选的星点虚化（`coc`），焦点在星云平面 |

色彩管线：星云板是 sRGB，先用 LUT 线性化；星点在线性光下**加性**累加；
最后统一做 filmic tonemap 再编码回 sRGB。这样亮星不会糊成一个死白的圆盘。

**确定性**：同一组 `Scene + RenderParams`，`renderFrame(i,n)` 跨进程逐位一致。
闪烁用 `mulberry32(seed)`，不用 `Math.random()`。

### 5. 导出

| 格式 | 面向平台 | 说明 |
|---|---|---|
| **MP4 (H.264)** | 任何地方 | 主交付物，faststart，可直接发社交平台 |
| **动态 WebP** | 所有现代浏览器 / iOS 14+ / Android | 最通用的"实况图"，单文件 |
| **Motion Photo** | Google Photos / 安卓相册 | 单张 JPEG，尾部内嵌 MP4，XMP 记录偏移 |
| **Live Photo 包** | macOS / iOS 照片（经转换工具） | ZIP：HEIC 静帧 + MOV + 配对 UUID |
| APNG | 所有浏览器 | 无损，体积大，已自动限制分辨率与帧率 |
| GIF | 到处都能放 | 兜底 |

---

## 关于"实况图"的一个诚实说明

**Apple 的 Live Photo 没有单文件格式。** 它本质上是一对资源：一张静帧（HEIC/JPEG）
加一段 MOV，两者靠一个共享的 `com.apple.quicktime.content.identifier` UUID 配对。

所以本应用导出的是：

- **动态 WebP** —— 真正的单文件实况图，浏览器和 iOS 相册都认；
- **Motion Photo** —— 真正的单文件实况图（JPEG 内嵌 MP4），Google Photos 认；
- **Live Photo 包** —— 一个 ZIP，里面就是 Apple 那一对资源 + `metadata.json`，
  可以用第三方工具导入照片 App。我们没有 Apple SDK，做不到"直接写进照片图库"。

---

## 目录结构

```
server/
  index.mjs            HTTP 服务、路由、静态资源
  config.mjs           路径、上限、默认参数
  lib/
    imageio.mjs        统一解码入口（PNG/JPG/WebP/TIFF/AVIF/HEIC/FITS）
    fits.mjs           零依赖 FITS 读取器（BITPIX 8/16/32/-32/-64、BZERO/BSCALE、多 HDU、去马赛克）
    astro.mjs          星点检测、PSF、深度分配、星点分离
    render.mjs         纯软件渲染器（无 GPU 依赖，确定性）
    encode.mjs         ffmpeg / img2webp 封装
    liveimage.mjs      Live Photo / Motion Photo / 动态 WebP 封装
    job.mjs            任务队列、进度、取消
    multipart.mjs      零依赖 multipart 解析
    http.mjs           路由与响应工具
  routes/
    upload.mjs         上传 / 分析 / 星云板
    jobs.mjs           渲染任务 / 进度 / 产物下载
web/                   前端（原生 ES 模块 + 最终产物播放器，无构建步骤）
samples/               内置样片（合成，可复现）
tools/make-samples.mjs 样片生成器
test/                  node:test 单元测试
docs/                  接口契约与验证报告
work/                  运行时产物（可随时删除）
```

---

## 常用命令

```bash
pnpm start            # 启动服务
pnpm test             # 单元测试
pnpm samples          # 重新生成内置样片（确定性，同 seed 逐字节一致）

# 命令行直接跑一遍完整流程
ID=$(curl -s -F "file=@samples/nebula-1600.png" http://127.0.0.1:8765/api/upload \
     | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
JOB=$(curl -s -X POST -H 'content-type: application/json' \
      -d "{\"id\":\"$ID\",\"format\":\"all\",\"params\":{\"durationSec\":6,\"fps\":30,\"resolution\":1280}}" \
      http://127.0.0.1:8765/api/render | python3 -c "import sys,json;print(json.load(sys.stdin)['jobId'])")
curl -s http://127.0.0.1:8765/api/jobs/$JOB | python3 -m json.tool
ls work/jobs/job-$JOB/
```

---

## 调参速查

| 参数 | 作用 | 建议 |
|---|---|---|
| `dolly` | 推近幅度 | 0.3–0.6 最自然；>0.8 会显得像变焦而非推进 |
| `parallax` | 视差强度 | 1.0 标准；2.0 很夸张，适合星场 |
| `depthSpread` | 深度层间距 | 0.6 默认；0.9 层次分明但可能显假 |
| `depthPower` | 亮度→深度曲线 | >1 让暗星更靠后，层次更集中 |
| `twinkle` | 闪烁 | 0.2–0.3；再高会像噪点 |
| `bloom` | 亮星光晕 | 0.4–0.6 |
| `occlusion` | 星云遮挡 | 0.5 左右；0 关闭 |
| `coc` | 景深强度 | 0.3 轻微；0 全清晰 |
| `focus` | 对焦平面（0 最近 / 1 最远） | 0.5 默认，落在星云附近 |

---

## 示例产物

`examples/` 里是用内置样片跑出来的一整套输出，可以直接查看：

| 文件 | 说明 |
|---|---|
| `deepsky-motion-*.mp4` | 4 秒 / 24fps / 960×640 推进视频，909 KB |
| `deepsky-motion-*.webp` | 动态 WebP「实况图」，827 KB，无限循环 |
| `deepsky-motion-*-livephoto.zip` | Apple Live Photo 包（HEIC + MOV + 配对 UUID） |
| `deepsky-motion-*-motionphoto.jpg` | Google Motion Photo 单文件（JPEG 内嵌 MP4） |
| `storyboard-first-mid-last.png` | 首帧 / 中间帧 / 末帧对照，可看出推进幅度与星点视差 |

## 性能

在 Apple M4 上实测（1250 颗星）：

| 分辨率 | 时长 | 渲染 | 单帧 |
|---|---|---|---|
| 960×640 | 4s @ 24fps | 1.4 s | 14 ms |
| 1280×854 | 6s @ 30fps | 5.3 s | 29 ms |
| 1920×1280 | 6s @ 30fps | 12.0 s | 67 ms |

星点分析（1600×1067）约 0.7 s；导出 `format=all` 全六种格式约 110 s（APNG 与 GIF 占大头）。

## 隐私

服务只监听 `127.0.0.1`。运行时不发起任何网络请求。
上传的图片只存在内存和 `work/` 目录里，删掉 `work/` 即彻底清除。
