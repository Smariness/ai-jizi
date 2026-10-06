# jimei.shufaziti.com 爬虫数据源协议（逆向自 iCalligraphy，2026-10-05 验证通过）

> 来源：参考 iCalligraphy（github.com/CK-KOP/iCalligraphy）的 single_char.py 找到目标站，
> 通过逆向 `common/shufa.js` 拿到真实数据端点，**纯 HTTP 即可访问，无需 playwright**。
> 授权状态：⚠️ 网站无开放数据声明——**仅限本地开发使用，禁止随安装包分发字形数据**。

## 一、数据链路（已端到端验证 ✓）

```
字符 c
  → dec = str(ord(繁体字符))            # Unicode 十进制码点，如 永=U+6C38 → "27704"
  → GET /datafile/czj/dat/{dec[4]}/{dec}.gif
      返回 JSON(带 BOM，用 utf-8-sig 解)：{"顏真卿多寶塔體":[5208],"虞世南":[59861,...],...}
      # 键 = 书家/碑帖名（即 manifest 的"来源名"），值 = 字形资源编号数组
  → GET /datafile/czj/zipp/{dec[-1]}/{dec}.zip2
      返回标准 ZIP：内含该字全部来源的矢量 SVG（编号.svg），一包全拿
```

实测（永，27704）：索引 686B / 16+ 来源；ZIP 48KB / **41 个 SVG**（1 秒完成），含
顏真卿多寶塔體、柳公權、行書-米芾、行書-集字聖教序（王羲之集字）、虞世南、智永、
張猛龍碑、趙孟頫三門記體、魏碑、隸書-伊秉綬 等。

## 二、端点清单（shufa.js 逆向）

| 库 | 索引/元数据 | 字形数据 | 说明 |
|---|---|---|---|
| **czj（主）** | `/datafile/czj/dat/{dec[4]}/{dec}.gif` → JSON | `/datafile/czj/zipp/{dec[-1]}/{dec}.zip2` → ZIP(SVG×N) | 书家/碑帖→编号；一包全拿 |
| sfj（备） | `/datafile/sfj/char/{x}/{n}.gif` → "米芾,x,125;..."（x=书体代号：x行/c草/k楷/z篆/l隶/n缺） | `/datafile/sfj/svgch/{x}/{n}.gif` → 单个 SVG | 逐个拉 |
| sbx | `/datafile/sbx/zs/dat/{x}/{n}.gif` → "世,陈潮,1q6e" | `/datafile/sbx/zs/zip/{...}` | 每条=字,书家,ID |
| zt / op | — | `/datafile/zt/zip/{...}`、`/datafile/op/zip/{...}` | 未验证 |

注：`{x}` = 编号字符串第 5 位（`n.substr(4,1)`），`{dec[-1]}` = 末位。GBK 常见于旧库，解析时注意编码。搜索页 URL 模式：`http://jimei.shufaziti.com/?char={字}&font=全部&size=160`（仅 JS 渲染壳，直连端点更稳）。

## 三、接入方案（产出 glyph-manifest-v1）

1. **SVG → PNG 光栅化**：SVG 直接内嵌 B5 也可行，但现有管线吃 256×256 透明 PNG——
   用 cairosvg/resvg 按墨迹 bbox 渲染，归一化后与 export_glyphs.py 同规格入库。
2. **来源名映射**：键名直接用（"顏真卿多寶塔體"→ 繁体保留或映射规范名），做一张
   来源名→书家/碑帖/书体 的清洗表（键里已含书体前缀如 "行書-米芾"）。
3. **爬取纪律**：①按需爬（先 test_texts 81 字 × 全来源验证质量，再扩常用集）②限速
   ≥1s/请求、带 UA、失败退避 ③白天错峰 ④增量缓存（码点→包已下不重下）。
4. **manifest 交接**：新增来源如 `"顏真卿多寶塔體": "glyphs_shufaziti/5208.png"`，
   与 ARMCD/lushen 来源并列——B3/B4/B5 零改动。

## 四、三源格局（B1 数据底座）

| 来源 | 授权 | 定位 |
|---|---|---|
| ARMCD | Apache-2.0 | 主力真迹（颜/赵/黄/蔡 碑帖质感） |
| lushen0124 | Apache-2.0 | 量大字全（7,328 字类） |
| shufaziti 集字站 | ⚠️ 灰色（无声明） | 矢量 SVG 补强 + 来源名自带书体信息；**仅本地开发，不分发** |
| MCCD | CC BY-NC-ND（申请中） | 到手后主库，四属性标注供 B6/B7 训练 |

## 五、风险与边界

- 爬取数据**不进安装包、不做二次分发**（与 shufazidian 同级灰色约定）。
- 若网站加反爬/改版，以本协议文档为准快速适配；核心端点已固化在本文。
- 商用/公开发布前，数据底座必须切换到授权干净来源（ARMCD/lushen/MCCD/CAOD）。
