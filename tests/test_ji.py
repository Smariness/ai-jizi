import contextlib
import io
from pathlib import Path
import tempfile
import unittest

from PIL import Image, ImageDraw

import ji


class FakeSource:
    """模拟以后数据库里的字形，验证排版确实与字体数据源解耦。"""
    def get_glyph(self, char, size):
        tile = Image.new("RGBA", (size, size))
        ImageDraw.Draw(tile).rectangle((2, 2, size - 3, size - 3), fill="#000000")
        return ji.Glyph(char, tile, "database-test")


class LayoutTests(unittest.TestCase):
    def test_unicode_punctuation_and_simplified_text(self):
        self.assertEqual(ji.normalize_text("海内，‘邻’！宁静致远；ＡＢ １２"), "海内邻宁静致远ＡＢ１２")
        self.assertEqual(ji.normalize_text("水，月。", True), "水，月。")

    def test_manual_columns_and_windows_newlines(self):
        text = ji.normalize_text("海内存知己\r\n天涯若比邻")
        self.assertEqual(ji.split_columns(text, 6), ["海内存知己", "天涯若比邻"])

    def test_vertical_order_with_alternative_source(self):
        image, report = ji.render_vertical("海内存知己，天涯若比邻", FakeSource(), ji.LayoutStyle(100, 5))
        self.assertEqual(report["columns_right_to_left"], ["海内存知己", "天涯若比邻"])
        self.assertEqual(report["char_gap"], 15)
        cells = report["cells"]
        self.assertGreater(cells[0]["x"], cells[5]["x"])
        self.assertEqual(cells[1]["y"] - cells[0]["y"], 115)
        self.assertEqual(image.getpixel((cells[0]["x"] + 3, cells[0]["y"] + 3)), (0, 0, 0))
        self.assertTrue(all(cell["source"] == "database-test" for cell in cells))

    def test_empty_input_and_invalid_dimensions(self):
        for text in ("", " ，。! ", "\n\r\t"):
            with self.assertRaises(ValueError):
                ji.render_vertical(text, FakeSource(), ji.LayoutStyle())
        for style in (ji.LayoutStyle(0, 5), ji.LayoutStyle(100, 0)):
            with self.assertRaises(ValueError):
                ji.render_vertical("水", FakeSource(), style)


class FontTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fonts = ji.discover_fonts(ji.ROOT / "fonts")

    def test_four_fonts_and_aliases(self):
        self.assertEqual(len(self.fonts), 4)
        primary = ji.find_font(self.fonts, "演示夏行楷")
        self.assertEqual(ji.find_font(self.fonts, "SlideXiaxing.ttf"), primary)
        self.assertIn(ord("海"), primary.cmap)
        with self.assertRaisesRegex(ValueError, "未找到字体"):
            ji.find_font(self.fonts, "不存在")

    def test_each_font_produces_visible_glyph(self):
        for font in self.fonts:
            glyph = ji.FontGlyphSource(font, self.fonts).get_glyph("海", 160)
            self.assertEqual(glyph.image.size, (160, 160))
            self.assertIsNotNone(glyph.image.getbbox())
            self.assertEqual(glyph.source, font.name)

    def test_fallback_and_strict_missing(self):
        primary = ji.find_font(self.fonts, "演示夏行楷")
        fallback = ji.find_font(self.fonts, "霞鹜文楷")
        # 从真实 cmap 选一个主字体缺少、文楷有的可见汉字。
        code = next(code for code in sorted(fallback.cmap - primary.cmap) if 0x4E00 <= code <= 0x9FFF)
        char = chr(code)
        glyph = ji.FontGlyphSource(primary, self.fonts).get_glyph(char, 160)
        self.assertEqual(glyph.source, "霞鹜文楷")
        with self.assertRaisesRegex(ValueError, "缺字"):
            ji.FontGlyphSource(primary, self.fonts, "error").get_glyph(char, 160)
        with self.assertRaisesRegex(ValueError, "缺字"):
            ji.FontGlyphSource(primary, self.fonts).get_glyph(chr(0x10FFFF), 160)

    def test_cli_failure_does_not_emit_png(self):
        with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stderr(io.StringIO()):
            out = Path(directory) / "empty.png"
            self.assertEqual(ji.main(["，。！", "--out", str(out)]), 2)
            self.assertFalse(out.exists())


if __name__ == "__main__":
    unittest.main()
