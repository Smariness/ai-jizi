# AI 自动集字 (AI JiZi)

输入一段文字，自动从**历代名家碑帖单字库**中选取字形、完成传统书法排版（竖排右起、无标点、落款与印章占位），并导出高清集字作品的**离线**工具。

> 传统「集字」是书法学习与创作的重要方式：从颜真卿、王羲之、米芾、赵孟頫等名家碑帖中集出所需单字，组合成完整作品。本项目把这条链路自动化，并且**完全离线运行**——没有云服务、没有账号，导出作品不留任何网络痕迹。

![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)

## 功能特性

| 模块 | 说明 |
|---|---|
| **CLI 集字** `ji.py` | 简体输入自动转繁体查询（OpenCC）、竖排右起、默认去标点、米字格、字号/每列字数可调、缺字报告 |
| **SVG 排版引擎** `layout.js` | 按字形 alpha 墨迹包围盒归一化对齐，支持横竖排、间距配置、落款与印章占位框，导出 2560px PNG |
| **桌面 GUI** `app/` | Electron 离线应用：SVG 预览、逐字候选切换（同一字可混用不同书家）、横竖排、一键导出 PNG |
| **三源字库构建** `build_glyph_db.py` / `crawl_shufaziti.py` | 将多个碑帖单字数据源统一入库 SQLite，产出 `glyph-manifest-v1` 接口文件 |
| **离线安装包** | electron-builder + NSIS 打包，安装后断网可用 |

## 目录结构

```
ai-jizi/
├── ji.py                  # CLI 集字
├── layout.js              # SVG 排版引擎
├── app/                   # Electron GUI
│   ├── main.js            #   主进程（禁网拦截 / 安全配置）
│   ├── service.js         #   本地服务层
│   └── renderer.js        #   渲染层（候选切换 / 导出）
├── build_glyph_db.py      # 多源字库入库
├── crawl_shufaziti.py     # 矢量字形源爬取（仅限本地研究使用）
├── query.py               # 简转繁查询层
├── jizi_data.py           # 数据访问公共库
├── export_glyphs.py       # 占位字形导出（从本地字体渲染）
├── tests/                 # 单元测试与数据管线测试
├── scripts/               # 验收脚本（verify_b3/b4/b5、打包校验等）
├── docs/                  # 接口文档、验收记录、授权台账
└── fonts/                 # 字体文件不入库（自备，见下文授权说明）
```

## 快速开始

### 1. 环境要求

- Python 3.10+
- Node.js 22+

### 2. 安装依赖

```bash
python -m venv .venv
source .venv/Scripts/activate   # Windows Git Bash；PowerShell 为 .venv\Scripts\Activate.ps1
pip install -r requirements.txt
npm install
```

### 3. 准备字形数据

本仓库**不含任何字形图片与字体文件**（授权原因，见下节）。获取方式：

```bash
# 方式一：从 Apache-2.0 数据集构建真迹字库（免申请）
python build_glyph_db.py --help

# 方式二：本地字体渲染占位字形（自备软笔字体 TTF/OTF 放入 fonts/）
python export_glyphs.py
```

### 4. 运行

```bash
# CLI 集字
python ji.py "海内存知己" --out output/demo.png

# SVG 排版
node layout.js --config docs/b5_style_example.json --out output/b5/demo

# GUI
npm start

# 测试
npm test
python -m unittest discover -s tests -v
```

## 数据来源与授权政策

**本仓库仅包含源代码与文档，不含任何字体文件与字形图片。**各数据源的授权边界：

| 数据源 | 授权 | 政策 |
|---|---|---|
| [MCCD](https://github.com/SCUT-DLVCLab/MCCD)（华南理工 DLVC-Lab，32.9 万张名家单字） | CC BY-NC-ND 4.0 | 仅限非商业研究，需向官方申请解压密码，**不得再分发**；代码预留 `data_slots` 接入位 |
| [ARMCD](https://github.com/lhl322001/ARMCD)（1.5 万张碑帖手稿单字） | Apache-2.0 | 可自由使用，遵守原仓声明 |
| [chinese-calligraphy-dataset](https://github.com/lushen0124/chinese-calligraphy-dataset)（13.8 万张） | Apache-2.0 | 可自由使用；原始图片爬自网络，商用需自行评估 |
| 书法字体集网站矢量字形 | 无公开声明 | **仅限本地研究使用**，严禁随安装包分发或二次公开 |
| 自备字体（放入 `fonts/`） | 逐源核对 | 嵌入式分发前必须核对授权，禁用「禁止嵌入」条款字体，核对记录见 `docs/LICENSE_RECORD.md` |

## 路线图

- [x] CLI 集字（简转繁、竖排右起、去标点、缺字报告）
- [x] SVG 排版引擎（墨迹归一化、落款印章占位）
- [x] Electron 离线 GUI（逐字候选切换、2560px 导出）
- [x] 离线安装包（NSIS，断网验证通过）
- [x] 多源字库入库 + 简转繁查询
- [ ] MCCD 数据接入（等待官方批准，接口已预留）
- [ ] AI 智能选字（风格一致性 embedding 打分 + 束搜索）

## License

代码以 [MIT](LICENSE) 发布。字体与碑帖字形数据归各自权利人所有，使用前请阅读上方授权政策。
