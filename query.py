"""Offline OpenCC s2t query of the three-source glyph database."""
import argparse
from contextlib import closing
import json
import sqlite3
import sys
from pathlib import Path

from jizi_data import ROOT, ORIGINS, S2T, candidates


def query_text(text, *, db_path=ROOT/'glyphs.db', origin=None, calligrapher=None):
    # Convert the whole phrase before looking up individual characters so
    # phrase-dependent variants (e.g. 干净 -> 乾淨) keep OpenCC's context.
    converted = S2T.convert(text)
    with closing(sqlite3.connect(Path(db_path).resolve().as_uri()+'?mode=ro', uri=True)) as db:
        db.row_factory = sqlite3.Row
        db.execute('BEGIN')
        return {'input':text, 'traditional':converted,
                'characters':[{'index':i,'input_char':text[i] if i<len(text) else None,
                               'char':c,'candidates':candidates(db,c,origin=origin,calligrapher=calligrapher,normalized=True)}
                              for i,c in enumerate(converted)]}


if __name__ == '__main__':
    # Pipe consumers (Node/PowerShell) must receive Unicode JSON as UTF-8,
    # regardless of Windows' legacy GBK code page.
    sys.stdout.reconfigure(encoding='utf-8')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('text')
    parser.add_argument('--db', type=Path, default=ROOT/'glyphs.db')
    parser.add_argument('--origin', choices=ORIGINS)
    parser.add_argument('--calligrapher')
    args = parser.parse_args()
    print(json.dumps(query_text(args.text, db_path=args.db, origin=args.origin,
                              calligrapher=args.calligrapher), ensure_ascii=False, indent=2))
