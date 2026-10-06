# MCCD 数据集申请指南（申请表流程版）

> ⚠️ 2026-10-03 核实：官方申请流程为「填写 docx 申请表 + 签名 → 发金老师邮箱审核」，早先的自由格式邮件模板已废弃。
> 官方申请表已下载：`ai-jizi/docs/Application-Form-for-Using-MCCD.docx`（17KB）。

---

## 一、回答：22GB 压缩包是什么？

**是完整数据集本体，不是文件清单**，内容（README 官方说明）：

| 内容 | 说明 |
|---|---|
| 约 33 万张名家书法**单字 PNG 图片** | 已从碑帖中切割好的单个汉字，这就是我们要的字形库本体 |
| **lmdb 标注数据库**（多个） | Character / Style / Dynasty / Calligrapher 单属性 + dual_task + four_task 多任务联合版，配套 `data_loader/` 读取脚本 |

- 网盘：百度网盘 `pan.baidu.com/s/1qkM_1gizNRBONEY47nw50g` 提取码 `8x7d`（可先转存）；OneDrive 备用链接见 MCCD 仓库 README。
- ⚠️ **压缩包有解压密码，申请批准后由对方邮件发给你**——所以"先转存、后申请"，密码下来才能解压。
- 数据集 2026-07-18 状态：Released，申请流程近期刚更新过。

---

## 二、官方申请表要填什么（已解析全文）

| 字段 | 建议填写（颜钰/学生身份） |
|---|---|
| Name of applicant | Yan Yu (颜钰) |
| Organization | Chongqing University（重庆大学） |
| Address / City / Zip / Country | 重庆市沙坪坝区沙正街174号 / Chongqing / 400044 / China |
| Tel / Email | 你的电话 / 你的邮箱 |
| Recent publications | 无论文可填 `None`（学生如实填） |
| 签名区 | **Signature (Applicant)**：申请人签名；**Signature (Your Leader)**：团队负责人签名（官方说明两者可以是同一人）；**Seal**：机构盖章（可选位置） |

### ⚠️ 表单里的硬性限制（原文）

> "Currently, we do not accept applications from **individual developers**."
> （目前不接受个人开发者申请）

表单同时要求签署 Legal Commitment（法律承诺：非商业研究用途、遵守 CC BY-NC-ND 4.0、不再分发数据）。

---

## 三、你的申请路径（按优先级）

| 路径 | 操作 | 成功率 |
|---|---|---|
| **① 挂靠学校（推荐）** | 找一位老师（课程/毕设/实验室指导老师）以重庆大学名义做 Leader 签字；zip 命名 `Chongqing University apply for the MCCD dataset`，邮件主题同名，发 `eelwjin@scut.edu.cn`（金老师，DLVC-Lab 负责人金莲文） | 高——学生项目挂靠学校是学术惯例 |
| **② 在线申请平台** | README 2026-07 更新提到在线平台：http://121.41.49.212:9000/ ，按表单走一遍看是否接受学生个人 | 未知，值得一试 |
| **③ 兜底：爬虫路线** | 若 ①② 都不通：shufazidian.com 爬虫方案（仅个人学习用，不随软件分发数据），B1 提示词切到爬虫版 | 可行但授权灰色 |

## 四、发送清单（路径①）

1. 填好 docx 申请表 → 打印签名（或电子签名）→ 扫描回 PDF/docx
2. Legal Commitment 签字件（若对方要求单独文件；可在邮件正文重申承诺条款）
3. 打包 zip：`Chongqing University apply for the MCCD dataset.zip`
4. 发邮件到 `eelwjin@scut.edu.cn`，**邮件主题 = zip 文件名**
5. 批准后收到解压密码 → 转存的网盘文件解压到 `ai-jizi/data/MCCD/` → 通知 GPT 开工 B1

## 五、等批准期间（不空等）

GPT 先跑 **B3+B5**（用 fonts/ 里 4 款现代字体占位，调试竖排出图 + 排版链路），MCCD 到手后 B1 入库、无缝切换真迹数据。

---

## 六、想提前"偷看"压缩包？（转存下载后可做）

**预期管理**：README 明确"批准后才发解压密码"，所以**实际解压必卡密码**，没有捷径，也不要浪费时间去猜。但 ZIP 一般只加密文件内容、不加密文件名——**列文件清单通常不需要密码**，能提前看到包结构。

操作顺序：

1. **转存**：百度网盘把分享文件存到自己网盘（提取码 `8x7d`）。
2. **下载**：22GB，客户端下载，**笔记本插电**；按 10MB/s 约 40 分钟，按 2MB/s 约 3 小时。
3. **列清单**（不需要密码，二选一）：
   - Windows 自带 tar（PowerShell / cmd 均可）：
     `tar -tf MCCD_*.zip > mccd_filelist.txt`
   - 装了 7-Zip 的话：`7z l MCCD_*.zip > mccd_filelist.txt`
   - 输出重定向到文件再打开，避免终端刷屏。
4. **能看到的**：目录结构（按书家/朝代分文件夹还是平铺）、PNG 数量级、lmdb 文件名——足够提前设计 B1 入库脚本的解析逻辑。
5. **看不到的**：图片内容本身（加密）。
6. 把 `mccd_filelist.txt` 放进 `ai-jizi/docs/`，GPT 可据此提前写好 B1 脚本骨架，密码到手当天就能跑通入库。
