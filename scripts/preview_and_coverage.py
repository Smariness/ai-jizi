# -*- coding: utf-8 -*-
"""简单活 1：用现有 4 款字体做测试文本覆盖率预检 + 竖排样张生成。
用途：MCCD 到手前验证字体可用性、提前暴露缺字；给 GPT 的 B3 CLI 当起点参考。
运行：python preview_and_coverage.py
"""
import json
from pathlib import Path

from fontTools.ttLib import TTFont
from opencc import OpenCC
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
FONTS = {
    "演示夏行楷": ROOT / "fonts" / "SlideXiaxing.ttf",
    "江西拙楷": ROOT / "fonts" / "JiangXiZhuoKai.ttf",
    "鸿雷行书简体": ROOT / "fonts" / "HongLeiXingShu.otf",
    "霞鹜文楷": ROOT / "fonts" / "LXGWWenKai-Regular.ttf",
}
PREVIEW_SENTENCES = ["海内存知己，天涯若比邻", "宁静致远", "上善若水"]

cc = OpenCC("s2t")


def load_cmap(path: Path) -> set:
    font = TTFont(str(path), fontNumber=0)
    return set(font.getBestCmap().keys())


def coverage_report() -> dict:
    report = {}
    for name, path in FONTS.items():
        cmap = load_cmap(path)
        entry = {"missing_simplified": {}, "missing_traditional": {}}
        for sent in PREVIEW_SENTENCES:
            t_sent = cc.convert(sent)
            miss_s = [ch for ch in sent if ch.strip() and ord(ch) not in cmap]
            miss_t = [ch for ch in t_sent if ch.strip() and ord(ch) not in cmap]
            if miss_s:
                entry["missing_simplified"][sent] = miss_s
            if miss_t:
                entry["missing_traditional"][sent] = miss_t
        entry["total_chars_in_cmap"] = len(cmap)
        report[name] = entry
    return report


def strip_punct(text: str) -> str:
    """传统书法作品默认不写标点：去掉中英文标点再排版。"""
    return "".join(
        ch for ch in text
        if not ('\u3000' <= ch <= '\u303F'   # CJK 标点 ，。、「」
                or '\uFF00' <= ch <= '\uFFEF'  # 全角标点 ！？：；
                or ch in ',.:;!?()[]{}\'"—…·'))
def render_vertical(name: str, path: Path, text: str, out: Path,
                    char_size: int = 110, col_chars: int = 5) -> None:
    """极简竖排右起渲染：列内自上而下，多列时从右往左；默认去标点。"""
    text = strip_punct(text)
    font = ImageFont.truetype(str(path), char_size)
    cols = [text[i:i + col_chars] for i in range(0, len(text), col_chars)]
    col_w = int(char_size * 1.25)
    row_h = int(char_size * 1.15)
    pad = 60
    width = pad * 2 + col_w * len(cols)
    height = pad * 2 + row_h * col_chars
    img = Image.new("RGB", (width, height), "#F7F4EC")
    draw = ImageDraw.Draw(img)
    for col_idx, col in enumerate(cols):  # 列从右往左
        x = width - pad - col_w * (col_idx + 1) + (col_w - char_size) // 2
        for row_idx, ch in enumerate(col):
            y = pad + row_idx * row_h
            bbox = font.getbbox(ch)
            w = bbox[2] - bbox[0]
            h = bbox[3] - bbox[1]
            draw.text((x + (char_size - w) / 2, y + (row_h - h) / 2 - bbox[1]),
                      ch, font=font, fill="#1A1A1A")
    img.save(out)


def main() -> None:
    out_dir = ROOT / "output"
    out_dir.mkdir(exist_ok=True)
    report = coverage_report()
    (ROOT / "docs" / "coverage_report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    for name, path in FONTS.items():
        for sent in PREVIEW_SENTENCES:
            render_vertical(name, path, sent,
                            out_dir / f"preview_{name}_{sent[:4]}.png")
        print(f"[样张] {name}: {len(PREVIEW_SENTENCES)} 张已生成")

    print("\n===== 覆盖率摘要（详见 docs/coverage_report.json）=====")
    for name, entry in report.items():
        miss_all = set()
        for d in entry["missing_simplified"].values():
            miss_all.update(d)
        for d in entry["missing_traditional"].values():
            miss_all.update(d)
        status = "全部覆盖 OK" if not miss_all else f"缺字: {''.join(sorted(miss_all))}"
        print(f"{name}: {status}")


if __name__ == "__main__":
    main()
