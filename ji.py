"""B3 占位 CLI：本地字体字形 → 竖排右起 PNG。"""
from __future__ import annotations

import argparse
from dataclasses import dataclass
import json
from pathlib import Path
import sys
from typing import Protocol
import unicodedata

from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent
FONT_ALIASES = {
    "SlideXiaxing.ttf": ("演示夏行楷", "夏行楷"),
    "JiangXiZhuoKai.ttf": ("江西拙楷", "拙楷"),
    "HongLeiXingShu.otf": ("鸿雷行书简体", "鸿雷行书", "鸿雷"),
    "LXGWWenKai-Regular.ttf": ("霞鹜文楷", "文楷"),
}


@dataclass(frozen=True)
class FontInfo:
    path: Path
    name: str
    aliases: frozenset[str]
    cmap: frozenset[int]


def discover_fonts(directory: Path) -> list[FontInfo]:
    """读取字体真实名称及 Unicode cmap；不使用系统字体的隐式兜底。"""
    if not directory.is_dir():
        raise ValueError(f"字体目录不存在：{directory}")
    fonts = []
    for path in sorted(directory.iterdir()):
        if path.suffix.lower() not in {".ttf", ".otf"}:
            continue
        try:
            with TTFont(str(path)) as font:
                cmap = frozenset(code for code, glyph in (font.getBestCmap() or {}).items()
                                 if glyph != ".notdef")
                names = set()
                for record in font["name"].names:
                    if record.nameID in {1, 2, 4, 6, 16, 17}:
                        try:
                            names.add(record.toUnicode())
                        except UnicodeError:
                            pass
        except Exception as exc:
            raise ValueError(f"无法读取字体 {path.name}：{exc}") from exc
        known = FONT_ALIASES.get(path.name, ())
        name = known[0] if known else path.stem
        aliases = frozenset({name, path.name, path.stem, *known, *names})
        fonts.append(FontInfo(path.resolve(), name, aliases, cmap))
    if not fonts:
        raise ValueError(f"没有找到 TTF/OTF 字体：{directory}")
    return fonts


def find_font(fonts: list[FontInfo], name: str) -> FontInfo:
    matches = [font for font in fonts
               if name.casefold() in {alias.casefold() for alias in font.aliases}]
    if len(matches) == 1:
        return matches[0]
    if len(matches) > 1:
        raise ValueError(f"字体名有歧义，请使用文件名：{name}")
    raise ValueError(f"未找到字体“{name}”；可选：{'、'.join(font.name for font in fonts)}")


@dataclass
class Glyph:
    char: str
    image: Image.Image  # 透明 RGBA 字身框；任何数据源都返回同一格式。
    source: str


class GlyphSource(Protocol):
    """后续 glyphs.db 适配器的边界；排版不读取字体或数据库。"""
    def get_glyph(self, char: str, size: int) -> Glyph: ...


class FontGlyphSource:
    def __init__(self, primary: FontInfo, fonts: list[FontInfo], missing: str = "fallback"):
        self.primary = primary
        self.missing = missing
        # 优先使用文楷兜底，其余字体按名称排序，结果可复现。
        self.fallbacks = sorted(
            (font for font in fonts if font.path != primary.path),
            key=lambda font: (font.name != "霞鹜文楷", font.name),
        )
        self._fonts: dict[tuple[Path, int], ImageFont.FreeTypeFont] = {}
        self._glyphs: dict[tuple[str, int], Glyph] = {}

    def font_for(self, char: str) -> FontInfo:
        if ord(char) in self.primary.cmap:
            return self.primary
        if self.missing == "fallback":
            for font in self.fallbacks:
                if ord(char) in font.cmap:
                    return font
        raise ValueError(f"字体“{self.primary.name}”缺字：{char} (U+{ord(char):04X})；"
                         "请添加包含该字的字体，或使用 --missing fallback")

    def get_glyph(self, char: str, size: int) -> Glyph:
        key = (char, size)
        if key in self._glyphs:
            return self._glyphs[key]
        info = self.font_for(char)
        font_key = (info.path, size)
        if font_key not in self._fonts:
            self._fonts[font_key] = ImageFont.truetype(str(info.path), size)
        font = self._fonts[font_key]
        left, top, right, bottom = font.getbbox(char)
        if right <= left or bottom <= top:
            raise ValueError(f"字形没有可见墨迹：{char}（{info.name}）")
        ink = Image.new("RGBA", (right - left, bottom - top), (0, 0, 0, 0))
        ImageDraw.Draw(ink).text((-left, -top), char, font=font, fill="#1A1A1A")
        bbox = ink.getbbox()
        if bbox is None:
            raise ValueError(f"字形没有可见墨迹：{char}（{info.name}）")
        ink = ink.crop(bbox)
        # 仅缩小溢出的字形；保留字体原有大小差异。
        ink.thumbnail((size, size), Image.Resampling.LANCZOS)
        tile = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        tile.alpha_composite(ink, ((size - ink.width) // 2, (size - ink.height) // 2))
        glyph = Glyph(char, tile, info.name)
        self._glyphs[key] = glyph
        return glyph


@dataclass(frozen=True)
class LayoutStyle:
    size: int = 160
    chars_per_column: int = 5
    grid: bool = False

    def validate(self) -> None:
        if not 16 <= self.size <= 2048:
            raise ValueError("字号 --size 必须在 16～2048 像素之间")
        if not 1 <= self.chars_per_column <= 200:
            raise ValueError("每列字数 --chars-per-column 必须在 1～200 之间")


def normalize_text(text: str, keep_punctuation: bool = False) -> str:
    """占位阶段不简转繁；Unicode 标点默认删除，换行保留为分列指令。"""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    result = []
    for char in text:
        if char == "\n":
            result.append(char)
        elif char.isspace() or unicodedata.category(char).startswith("C"):
            continue
        elif not keep_punctuation and unicodedata.category(char).startswith("P"):
            continue
        else:
            result.append(char)
    return "".join(result).strip("\n")


def split_columns(text: str, chars_per_column: int) -> list[str]:
    return [line[start:start + chars_per_column]
            for line in text.split("\n")
            for start in range(0, len(line), chars_per_column)]


def draw_grid(draw: ImageDraw.ImageDraw, x: int, y: int, size: int) -> None:
    color = "#CDBBA5"
    edge = size - 1
    draw.rectangle((x, y, x + edge, y + edge), outline=color)
    # 米字格辅助线采用虚线，先画格再叠字。
    guides = [(0, size / 2, edge, size / 2), (size / 2, 0, size / 2, edge),
              (0, 0, edge, edge), (edge, 0, 0, edge)]
    steps = max(1, size // 8)
    for x1, y1, x2, y2 in guides:
        for step in range(0, steps, 2):
            start, end = step / steps, min(step + 1, steps) / steps
            draw.line((x + x1 + (x2 - x1) * start, y + y1 + (y2 - y1) * start,
                       x + x1 + (x2 - x1) * end, y + y1 + (y2 - y1) * end),
                      fill=color)


def render_vertical(text: str, source: GlyphSource, style: LayoutStyle,
                    keep_punctuation: bool = False) -> tuple[Image.Image, dict]:
    style.validate()
    normalized = normalize_text(text, keep_punctuation)
    columns = split_columns(normalized, style.chars_per_column)
    if not columns:
        raise ValueError("去除标点和空白后没有可排版的字符")
    size = style.size
    gap = round(size * 0.15)
    col_gap = round(size * 0.25)
    margin = round(size * 0.5)
    rows = max(len(column) for column in columns)
    width = 2 * margin + len(columns) * size + (len(columns) - 1) * col_gap
    height = 2 * margin + rows * size + (rows - 1) * gap
    if width * height > 64_000_000:
        raise ValueError("画布超过 6400 万像素，请减小字号或拆分文本")
    image = Image.new("RGB", (width, height), "#F7F4EC")
    draw = ImageDraw.Draw(image)
    cells = []
    for column_index, column in enumerate(columns):
        x = width - margin - size - column_index * (size + col_gap)
        for row_index, char in enumerate(column):
            y = margin + row_index * (size + gap)
            glyph = source.get_glyph(char, size)
            if glyph.image.mode != "RGBA" or glyph.image.size != (size, size):
                raise ValueError("字形数据源必须返回与字号同大的 RGBA 字身框")
            if style.grid:
                draw_grid(draw, x, y, size)
            image.paste(glyph.image, (x, y), glyph.image)
            cells.append({"char": char, "column": column_index, "row": row_index,
                          "x": x, "y": y, "source": glyph.source})
    report = {
        "input_text": text, "rendered_text": "".join(columns),
        "columns_right_to_left": columns, "direction": "vertical-rtl",
        "width": width, "height": height, "size": size,
        "char_gap": gap, "column_gap": col_gap, "margin": margin,
        "grid": style.grid, "keep_punctuation": keep_punctuation,
        "simplified_to_traditional": False, "cells": cells,
    }
    return image, report


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="B3 占位版：本地字体 → 竖排右起 PNG（默认去标点）")
    parser.add_argument("text", nargs="?", help="待集字文本；换行可手动分列")
    parser.add_argument("--font", default="演示夏行楷", help="字体名称、别名或字体文件名")
    parser.add_argument("--out", type=Path, default=Path("out.png"), help="PNG 输出路径")
    parser.add_argument("--fonts-dir", type=Path, default=ROOT / "fonts")
    parser.add_argument("--list-fonts", action="store_true", help="列出字体名称和 cmap 覆盖数")
    parser.add_argument("--size", type=int, default=160, help="字身框边长（像素）")
    parser.add_argument("--chars-per-column", type=int, default=5, help="每列最多字数")
    parser.add_argument("--grid", action="store_true", help="绘制米字格")
    parser.add_argument("--keep-punctuation", action="store_true", help="保留标点")
    parser.add_argument("--missing", choices=("fallback", "error"), default="fallback",
                        help="缺字策略；默认优先用霞鹜文楷兜底，并报告换字体的字")
    parser.add_argument("--report", type=Path, help="另存 JSON 排版/字形来源报告")
    return parser


def main(argv: list[str] | None = None) -> int:
    # Windows 管道常用旧代码页；统一为 UTF-8，避免终端中的中文提示乱码。
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        fonts = discover_fonts(args.fonts_dir)
        if args.list_fonts:
            for font in fonts:
                print(f"{font.name}\t{font.path.name}\tcmap={len(font.cmap)}")
            return 0
        if args.text is None:
            parser.error("请提供文本，或使用 --list-fonts")
        if args.out.suffix.lower() != ".png":
            raise ValueError("--out 必须使用 .png 扩展名")
        if args.report and args.report.resolve() == args.out.resolve():
            raise ValueError("--report 和 --out 不能是同一路径")
        primary = find_font(fonts, args.font)
        source = FontGlyphSource(primary, fonts, args.missing)
        style = LayoutStyle(args.size, args.chars_per_column, args.grid)
        image, report = render_vertical(args.text, source, style, args.keep_punctuation)
        fallbacks = {cell["char"]: cell["source"] for cell in report["cells"]
                     if cell["source"] != primary.name}
        report.update({"primary_font": primary.name, "font_file": str(primary.path),
                       "fallbacks": fallbacks, "output": str(args.out.resolve())})
        args.out.parent.mkdir(parents=True, exist_ok=True)
        image.save(args.out, format="PNG")
        if args.report:
            args.report.parent.mkdir(parents=True, exist_ok=True)
            args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        if fallbacks:
            detail = "、".join(f"{char}→{name}" for char, name in fallbacks.items())
            print(f"[缺字兜底] {detail}", file=sys.stderr)
        print(f"已生成 {args.out.resolve()} ({image.width}×{image.height}，"
              f"{len(report['rendered_text'])} 字，{len(report['columns_right_to_left'])} 列)")
        return 0
    except (ValueError, OSError) as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
