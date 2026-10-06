import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest

from PIL import Image

from scripts import export_glyphs as exporter


class ExportTests(unittest.TestCase):
    def test_current_text_has_81_unique_simplified_characters(self):
        chars = exporter.collect_chars()
        self.assertEqual(len(chars), 81)
        self.assertEqual(chars, sorted(set(chars)))
        self.assertIn("内", chars)
        self.assertNotIn("內", chars)
        self.assertNotIn("，", chars)

    def test_unicode_punctuation_and_whitespace(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "texts.txt"
            path.write_text("\ufeff海内，海内！\t\n‘静’ Ａ", encoding="utf-8")
            self.assertEqual(set(exporter.collect_chars(path)), {"海", "内", "静", "Ａ"})

    def test_export_preserves_v1_mapping_and_transparency(self):
        with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stdout(io.StringIO()):
            root = Path(directory)
            text = root / "texts.txt"
            text.write_text("海内，海内", encoding="utf-8")
            manifest_path = root / "docs/manifest.json"
            report = exporter.export_glyphs(text, exporter.ROOT / "fonts", root / "glyphs",
                                            manifest_path, root / "docs/report.json")
            self.assertEqual(report["image_count"], 8)
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertEqual(set(manifest), {"format", "note", "fonts", "chars"})
            self.assertEqual(manifest["format"], "glyph-manifest-v1")
            self.assertEqual(set(manifest["chars"]), {"海", "内"})
            for variants in manifest["chars"].values():
                self.assertEqual(set(variants), set(exporter.FONT_NAMES))
                for filename in variants.values():
                    exporter.validate_png(Path(filename))
            for font in manifest["fonts"].values():
                self.assertEqual(set(font), {"path", "dir", "missing"})
                self.assertEqual(font["missing"], [])

    def test_missing_cmap_fails_before_mutating_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            text = root / "texts.txt"
            text.write_text("海😀", encoding="utf-8")
            manifest = root / "manifest.json"
            manifest.write_text("keep-existing", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "cmap 预检发现缺字"):
                exporter.export_glyphs(text, exporter.ROOT / "fonts", root / "glyphs",
                                       manifest, root / "report.json")
            self.assertEqual(manifest.read_text(encoding="utf-8"), "keep-existing")
            self.assertFalse((root / "glyphs").exists())

    def test_validator_rejects_opaque_or_blank_png(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "bad.png"
            for color in ((0, 0, 0, 0), (26, 26, 26, 255)):
                Image.new("RGBA", (256, 256), color).save(path)
                with self.assertRaises(ValueError):
                    exporter.validate_png(path)


if __name__ == "__main__":
    unittest.main()
