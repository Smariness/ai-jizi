"""通过真实 CLI 运行 10 条文本 × 4 字体，保存可复核的图和报告。"""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys

from PIL import Image, ImageChops, ImageDraw, ImageFont, ImageOps

ROOT = Path(__file__).resolve().parent.parent
FONT_NAMES = ["演示夏行楷", "江西拙楷", "鸿雷行书简体", "霞鹜文楷"]


def run_cli(*args: str) -> subprocess.CompletedProcess:
    result = subprocess.run([sys.executable, str(ROOT / "ji.py"), *args],
                            cwd=ROOT, capture_output=True, text=True, encoding="utf-8",
                            env={**os.environ, "PYTHONIOENCODING": "utf-8"})
    if result.returncode:
        raise RuntimeError(result.stderr or result.stdout)
    return result


def check_image(path: Path, report: dict, text: str) -> None:
    import unicodedata
    expected = "".join(char for char in text if not char.isspace()
                       and not unicodedata.category(char).startswith("P"))
    assert report["rendered_text"] == expected, path
    assert report["simplified_to_traditional"] is False, path
    assert report["char_gap"] == round(report["size"] * 0.15), path
    columns = report["columns_right_to_left"]
    assert "".join(columns) == expected, path
    first_x = [cell["x"] for cell in report["cells"] if cell["row"] == 0]
    assert all(left > right for left, right in zip(first_x, first_x[1:])), path
    with Image.open(path) as image:
        assert image.format == "PNG", path
        assert image.size == (report["width"], report["height"]), path
        image.load()
        for cell in report["cells"]:
            x, y, size = cell["x"], cell["y"], report["size"]
            tile = image.crop((x, y, x + size, y + size))
            blank = Image.new("RGB", tile.size, "#F7F4EC")
            assert ImageChops.difference(tile, blank).getbbox() is not None, (path, cell)


def make_sheet(results: list[dict], output: Path, first_only: bool) -> None:
    width, height = 360, 410
    rows = 1 if first_only else 10
    sheet = Image.new("RGB", (width * 4, height * rows), "#E9E3D7")
    draw = ImageDraw.Draw(sheet)
    font = ImageFont.truetype(str(ROOT / "fonts" / "LXGWWenKai-Regular.ttf"), 21)
    for result in results:
        if first_only and result["text_index"] != 1:
            continue
        col = FONT_NAMES.index(result["font"])
        row = 0 if first_only else result["text_index"] - 1
        x, y = col * width, row * height
        draw.text((x + 12, y + 8), f"{result['text_index']:02d}  {result['font']}",
                  font=font, fill="#333333")
        with Image.open(ROOT / result["output"]) as image:
            thumb = ImageOps.contain(image, (width - 20, height - 46))
            sheet.paste(thumb, (x + (width - thumb.width) // 2, y + 40))
    sheet.save(output)


def main() -> None:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    texts = [line.strip() for line in (ROOT / "test_texts.txt").read_text(encoding="utf-8-sig").splitlines()
             if line.strip()]
    assert len(texts) == 10, "B3 验收要求恰好 10 条测试文本"
    out = ROOT / "output" / "acceptance"
    out.mkdir(parents=True, exist_ok=True)
    results = []
    for index, text in enumerate(texts, start=1):
        for name in FONT_NAMES:
            path = out / f"{index:02d}_{name}.png"
            report_path = path.with_suffix(".json")
            process = run_cli(text, "--font", name, "--out", str(path), "--report", str(report_path))
            report = json.loads(report_path.read_text(encoding="utf-8"))
            check_image(path, report, text)
            results.append({"text_index": index, "text": text, "font": name,
                            "output": path.relative_to(ROOT).as_posix(),
                            "report": report_path.relative_to(ROOT).as_posix(),
                            "fallbacks": report["fallbacks"], "passed": True})
            print(f"[{len(results):02d}/40] {name} / {text}", flush=True)
            if process.stderr.strip():
                print(process.stderr.strip(), flush=True)
    run_cli(texts[0], "--font", FONT_NAMES[0], "--grid", "--out", str(out / "grid.png"))
    with Image.open(out / "grid.png") as grid, Image.open(out / "01_演示夏行楷.png") as plain:
        assert grid.size == plain.size
        assert ImageChops.difference(grid, plain).getbbox() is not None
    make_sheet(results, out / "comparison.png", first_only=True)
    make_sheet(results, out / "contact_sheet.png", first_only=False)
    summary = {"total": len(results), "passed": sum(item["passed"] for item in results),
               "fallback_render_count": sum(bool(item["fallbacks"]) for item in results),
               "grid_verified": True, "results": results}
    (out / "acceptance_report.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2),
                                               encoding="utf-8")
    print(f"验收完成：{summary['passed']}/{summary['total']}；米字格验证通过。", flush=True)


if __name__ == "__main__":
    main()
