"""四款本地字体 → 256×256 RGBA 字形图及兼容的 glyph-manifest-v1。"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from ji import FontGlyphSource, discover_fonts, find_font, normalize_text

FONT_NAMES = ("演示夏行楷", "江西拙楷", "鸿雷行书简体", "霞鹜文楷")
SIZE = 256
BODY_SIZE = int(SIZE * 0.8)


def collect_chars(text_file: Path = ROOT / "test_texts.txt") -> list[str]:
    """保持简体，复用 B3 的 Unicode 去标点规则，按码点排序去重。"""
    text = normalize_text(text_file.read_text(encoding="utf-8-sig"))
    chars = sorted({char for char in text if not char.isspace()})
    if not chars:
        raise ValueError("测试文本去除标点及空白后没有字符")
    return chars


def glyph_filename(char: str) -> str:
    suffix = "" if char in '<>:"/\\|?*' else f"_{char}"
    return f"U+{ord(char):04X}{suffix}.png"


def render_glyph(source: FontGlyphSource, char: str) -> Image.Image:
    glyph = source.get_glyph(char, BODY_SIZE)
    image = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    inset = (SIZE - BODY_SIZE) // 2
    image.alpha_composite(glyph.image, (inset, inset))
    return image


def validate_png(path: Path) -> tuple[int, int, int, int]:
    with Image.open(path) as image:
        image.load()
        if image.format != "PNG" or image.mode != "RGBA" or image.size != (SIZE, SIZE):
            raise ValueError(f"图像不是 {SIZE}×{SIZE} RGBA PNG：{path}")
        alpha = image.getchannel("A")
        bbox = alpha.getbbox()
        if not bbox or alpha.getextrema() != (0, 255):
            raise ValueError(f"没有可见墨迹或透明背景：{path}")
        left, top, right, bottom = bbox
        if min(left, top, SIZE - right, SIZE - bottom) < SIZE // 10:
            raise ValueError(f"墨迹未保留至少 10% 边距：{path}")
        return bbox


def write_json_atomic(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                         suffix=".tmp", delete=False) as stream:
            temporary = Path(stream.name)
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
        os.replace(temporary, path)
    finally:
        if temporary and temporary.exists():
            temporary.unlink()


def export_glyphs(text_file: Path, fonts_dir: Path, out_dir: Path,
                  manifest_path: Path, report_path: Path) -> dict:
    text_file, fonts_dir, out_dir, manifest_path, report_path = (
        path.resolve() for path in (text_file, fonts_dir, out_dir, manifest_path, report_path)
    )
    if manifest_path == report_path:
        raise ValueError("manifest 与验收报告不能使用同一路径")
    chars = collect_chars(text_file)
    available = discover_fonts(fonts_dir)
    fonts = [find_font(available, name) for name in FONT_NAMES]
    # Pillow 缺字时也可能画 .notdef 方框，必须先用 cmap 检查全部字。
    missing = {font.name: [char for char in chars if ord(char) not in font.cmap] for font in fonts}
    failures = {name: items for name, items in missing.items() if items}
    if failures:
        detail = "；".join(f"{name}：{''.join(items)}" for name, items in failures.items())
        raise ValueError(f"cmap 预检发现缺字，未修改已有字形图或 manifest：{detail}")
    manifest = {"format": "glyph-manifest-v1", "note": "占位字形图，MCCD 到手后同格式替换",
                "fonts": {}, "chars": {char: {} for char in chars}}
    coverage = {}
    out_dir.parent.mkdir(parents=True, exist_ok=True)
    # 全部图片先在临时目录完成渲染与验证；通过后发布图片，最后提交 manifest。
    with tempfile.TemporaryDirectory(prefix=".glyphs-export-", dir=out_dir.parent) as staging:
        staged = Path(staging)
        for font in fonts:
            source = FontGlyphSource(font, available, missing="error")
            destination = out_dir / font.name
            stage_font = staged / font.name
            stage_font.mkdir()
            for char in chars:
                filename = glyph_filename(char)
                render_glyph(source, char).save(stage_font / filename, format="PNG")
                validate_png(stage_font / filename)
                manifest["chars"][char][font.name] = str(destination / filename)
            manifest["fonts"][font.name] = {"path": str(font.path), "dir": str(destination), "missing": []}
            coverage[font.name] = {"count": len(chars), "missing": [], "fallback_count": 0}
            print(f"[{font.name}] cmap 覆盖 {len(chars)}/{len(chars)}，透明图验证通过", flush=True)
        for font in fonts:
            destination = out_dir / font.name
            destination.mkdir(parents=True, exist_ok=True)
            for char in chars:
                filename = glyph_filename(char)
                os.replace(staged / font.name / filename, destination / filename)
        write_json_atomic(manifest_path, manifest)
    report = {
        "format": "glyph-export-report-v1", "manifest_format": manifest["format"],
        "text_file": str(text_file), "text_sha256": hashlib.sha256(text_file.read_bytes()).hexdigest(),
        "manifest": str(manifest_path), "glyph_directory": str(out_dir),
        "unique_char_count": len(chars), "font_count": len(fonts),
        "image_count": len(chars) * len(fonts), "canvas_size": [SIZE, SIZE], "mode": "RGBA",
        "transparent_background": True, "minimum_margin_pixels": SIZE // 10,
        "missing_count": 0, "fallback_count": 0,
        "simplified_to_traditional": False, "fonts": coverage,
    }
    write_json_atomic(report_path, report)
    return report


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="导出四字体 256×256 透明底单字 PNG；缺字即失败")
    parser.add_argument("--text-file", type=Path, default=ROOT / "test_texts.txt")
    parser.add_argument("--fonts-dir", type=Path, default=ROOT / "fonts")
    parser.add_argument("--out-dir", type=Path, default=ROOT / "glyphs_placeholder")
    parser.add_argument("--manifest", type=Path, default=ROOT / "docs" / "glyph_manifest.json")
    parser.add_argument("--report", type=Path, default=ROOT / "docs" / "glyph_export_report.json")
    args = parser.parse_args(argv)
    try:
        report = export_glyphs(args.text_file, args.fonts_dir, args.out_dir, args.manifest, args.report)
        print(f"完成：{report['unique_char_count']} 字 × {report['font_count']} 字体 = "
              f"{report['image_count']} 张，零缺字、零兜底。")
        print(f"manifest：{report['manifest']}")
        return 0
    except (ValueError, OSError) as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
