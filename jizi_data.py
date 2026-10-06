"""B1/B2 shared data contract. No network access in the query layer."""
from __future__ import annotations

import hashlib
import io
import json
import re
import sqlite3
import unicodedata
import opencc
from pathlib import Path

from opencc import OpenCC
from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parent
S2T = OpenCC('s2t')
T2S = OpenCC('t2s')
T2TW = OpenCC('t2tw')
ORIGINS = ('armcd', 'lushen', 'shufaziti', 'mccd')
SIX = ('王羲之', '颜真卿', '苏轼', '米芾', '文徵明', '赵孟頫')
AMBIGUOUS_S2T = {line.split('\t')[0] for line in
    (Path(opencc.__file__).parent/'dictionary/STCharacters.txt').read_text(encoding='utf8').splitlines()
    if '\t' in line and len(line.split('\t')[1].split()) > 1}


def han_chars(text: str) -> list[str]:
    return list(dict.fromkeys(c for c in text if unicodedata.category(c) == 'Lo'
                             and ('CJK' in unicodedata.name(c, '') or c == '〇')))


def write_json(path: Path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + '.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    temp.replace(path)


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def normalize_calligrapher(name):
    simple=T2S.convert(name)
    return {'文征明':'文徵明','赵孟俯':'赵孟頫'}.get(simple,simple)


def open_db(path: Path = ROOT / 'glyphs.db') -> sqlite3.Connection:
    db = sqlite3.connect(path, timeout=60)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA foreign_keys=ON')
    db.executescript('''
        CREATE TABLE IF NOT EXISTS glyphs (
            id INTEGER PRIMARY KEY,
            char TEXT NOT NULL,
            calligrapher TEXT NOT NULL,
            style TEXT NOT NULL DEFAULT '',
            dynasty TEXT NOT NULL DEFAULT '',
            source_work TEXT NOT NULL,
            image_path TEXT NOT NULL,
            origin TEXT NOT NULL,
            upstream_id TEXT NOT NULL,
            upstream_label TEXT NOT NULL DEFAULT '',
            sha256 TEXT NOT NULL,
            distributable INTEGER NOT NULL DEFAULT 0,
            UNIQUE(origin, upstream_id)
        );
        CREATE INDEX IF NOT EXISTS idx_glyphs_char ON glyphs(char);
        CREATE INDEX IF NOT EXISTS idx_glyphs_char_calligrapher ON glyphs(char, calligrapher);
        CREATE INDEX IF NOT EXISTS idx_glyphs_origin ON glyphs(origin);
        CREATE TABLE IF NOT EXISTS sources (
            origin TEXT PRIMARY KEY, url TEXT, license TEXT, distributable INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS imports (
            origin TEXT, upstream_id TEXT, status TEXT, detail TEXT,
            PRIMARY KEY(origin, upstream_id)
        );
        CREATE TABLE IF NOT EXISTS character_aliases (
            raw_char TEXT PRIMARY KEY, canonical_char TEXT NOT NULL,
            unambiguous INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_character_aliases_canonical ON character_aliases(canonical_char);
    ''')
    for origin, url, license_name, permitted in (
        ('armcd', 'https://github.com/lhl322001/ARMCD', 'Apache-2.0 (upstream repository)', 1),
        ('lushen', 'https://github.com/lushen0124/chinese-calligraphy-dataset', 'Apache-2.0 (upstream repository)', 1),
        ('shufaziti', 'http://jimei.shufaziti.com', 'LOCAL DEVELOPMENT ONLY; NO REDISTRIBUTION', 0),
        ('mccd', '', 'pending application; do not distribute', 0),
    ):
        db.execute('INSERT OR REPLACE INTO sources VALUES(?,?,?,?)', (origin, url, license_name, permitted))
    db.commit()
    return db


def put_glyph(db, *, char, calligrapher, style, dynasty, source_work,
              image_path, origin, upstream_id, upstream_label='', image_sha256=None):
    if origin not in ORIGINS or len(char) != 1:
        raise ValueError('invalid origin or character')
    calligrapher=normalize_calligrapher(calligrapher)
    relative = Path(image_path).resolve().relative_to(ROOT).as_posix()
    digest = image_sha256 or sha256((ROOT / relative).read_bytes())
    db.execute('INSERT OR REPLACE INTO character_aliases VALUES(?,?,?)',
               (char,S2T.convert(char),int(char not in AMBIGUOUS_S2T)))
    db.execute('''INSERT INTO glyphs
        (char,calligrapher,style,dynasty,source_work,image_path,origin,upstream_id,
         upstream_label,sha256,distributable) VALUES(?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(origin,upstream_id) DO UPDATE SET
          char=excluded.char,calligrapher=excluded.calligrapher,style=excluded.style,
          dynasty=excluded.dynasty,source_work=excluded.source_work,
          image_path=excluded.image_path,upstream_label=excluded.upstream_label,
          sha256=excluded.sha256,distributable=excluded.distributable''',
        (char, calligrapher, style, dynasty, source_work, relative, origin,
         str(upstream_id), upstream_label, digest, int(origin in ('armcd', 'lushen'))))


def source_name(row) -> str:
    return row['calligrapher'] + '·' + row['source_work']


def traditional_variants(char, *, normalized=True):
    canonical = char if normalized else S2T.convert(char)
    return list(dict.fromkeys((canonical, T2TW.convert(canonical))))


def expand_label_aliases(present):
    return set(present) | {S2T.convert(c) for c in present if c not in AMBIGUOUS_S2T}


def normalize_png(data: bytes, *, svg=False) -> tuple[bytes, dict]:
    if svg:
        import resvg_py
        text = data.decode('utf-8-sig')
        # The upstream Potrace SVG has a harmless external SVG 1.0 DOCTYPE.
        # Remove it before parsing; reject entities and external resource references.
        text = re.sub(r'<!DOCTYPE\s+svg\b[^>]*>', '', text, flags=re.I | re.S)
        if re.search(r'<!ENTITY|<(?:script|image|use|foreignObject)\b|(?:href|url\s*\()|@import', text, re.I):
            raise ValueError('SVG external or executable content rejected')
        # Explicit DPI is essential for Potrace's pt dimensions (resvg_py's
        # default dpi=0 otherwise gives a zero-size canvas).
        data = resvg_py.svg_to_bytes(svg_string=text, width=1024, dpi=96.0, skip_system_fonts=True)
    with Image.open(io.BytesIO(data)) as original:
        original.seek(0)
        rgba = original.convert('RGBA')
    if rgba.width * rgba.height > 25_000_000:
        raise ValueError('image too large')
    if rgba.getextrema()[3][0] < 255:
        alpha = rgba.getchannel('A')
    else:
        gray = ImageOps.grayscale(rgba)
        # Most upstream images are dark ink on white. Negative rubbings are
        # inferred from the border only, never from the character's interior.
        border = [gray.getpixel((x, y)) for x, y in (
            (0, 0), (gray.width-1, 0), (0, gray.height-1), (gray.width-1, gray.height-1))]
        negative = sorted(border)[2] < 90
        alpha = gray if negative else ImageOps.invert(gray)
        alpha = alpha.point(lambda p: 0 if p < 24 else p)
    box = alpha.getbbox()
    if not box:
        raise ValueError('empty ink')
    ink = alpha.crop(box)
    ink.thumbnail((206, 206), Image.Resampling.LANCZOS)
    canvas = Image.new('RGBA', (256, 256), (0, 0, 0, 0))
    tile = Image.new('RGBA', ink.size, (0, 0, 0, 255))
    tile.putalpha(ink)
    canvas.alpha_composite(tile, ((256-ink.width)//2, (256-ink.height)//2))
    out = io.BytesIO()
    canvas.save(out, format='PNG')
    return out.getvalue(), {'input_size': list(rgba.size), 'ink_bbox': list(canvas.getbbox()),
                           'output_size': [256, 256], 'mode': 'RGBA'}


def candidates(db, char: str, *, origin=None, calligrapher=None, normalized=False):
    variants = traditional_variants(char,normalized=normalized)
    marks=','.join('?' for _ in variants)
    clauses = [f'(char IN ({marks}) OR char IN (SELECT raw_char FROM character_aliases '
               f'WHERE canonical_char IN ({marks}) AND unambiguous=1))']
    args = variants + variants
    if origin:
        if origin not in ORIGINS:
            raise ValueError('unknown origin')
        clauses.append('origin = ?')
        args.append(origin)
    if calligrapher:
        clauses.append('calligrapher = ?')
        args.append(normalize_calligrapher(calligrapher))
    result = []
    for row in db.execute('SELECT * FROM glyphs WHERE ' + ' AND '.join(clauses) +
                          ' ORDER BY calligrapher,source_work,origin,upstream_id', args):
        item = dict(row)
        item.update(source=source_name(row), path=(ROOT / row['image_path']).as_posix())
        result.append(item)
    return result
