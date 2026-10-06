"""Meaningful regression checks for provenance, normalization and offline use."""
import io
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image, ImageDraw

from jizi_data import ROOT, candidates, normalize_png, open_db, put_glyph, traditional_variants
from build_glyph_db import manifest, coverage, lushen_meta
from crawl_shufaziti import CachedHTTP, source_metadata
from query import query_text


class DataPipelineTests(unittest.TestCase):
    def setUp(self):
        folder = ROOT/'output/b1_b2'
        folder.mkdir(parents=True,exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix='test_owned_',dir=folder)
        self.base = Path(self.temp.name).resolve()
        assert self.base.is_relative_to(folder.resolve())
        self.db_path = self.base/'test.db'
        self.db = open_db(self.db_path)
        image = Image.new('RGBA',(256,256),(0,0,0,0))
        ImageDraw.Draw(image).rectangle((25,25,230,230),fill='black')
        self.png = self.base/'fixture.png'
        image.save(self.png)

    def tearDown(self):
        self.db.close()
        # Only the verified per-test temporary subtree is removed.
        assert self.base.is_relative_to((ROOT/'output/b1_b2').resolve())
        self.temp.cleanup()

    def add(self,char,origin,key,author='颜真卿'):
        put_glyph(self.db,char=char,origin=origin,upstream_id=key,calligrapher=author,
                  source_work='多宝塔碑',style='楷书',dynasty='唐',image_path=self.png)
        self.db.commit()

    def test_origin_upsert_preserves_other_sources(self):
        self.add('海','armcd','same')
        self.add('海','lushen','same')
        self.add('海','shufaziti','same')
        self.add('海','lushen','same')
        self.assertEqual(self.db.execute('SELECT count(*) FROM glyphs').fetchone()[0],3)
        self.assertEqual(len(candidates(self.db,'海',origin='armcd')),1)
        self.assertFalse(candidates(self.db,'海',calligrapher="颜真卿' OR 1=1 --"))

    def test_phrase_conversion_and_traditional_variant(self):
        self.add('乾','lushen','1')
        self.add('淨','lushen','2')
        self.add('為','lushen','3')
        value = query_text('干净',db_path=self.db_path)
        self.assertEqual(value['traditional'],'乾淨')
        self.assertTrue(all(c['candidates'] for c in value['characters']))
        self.assertEqual(candidates(self.db,'为')[0]['char'],'為')
        self.assertEqual(coverage(['爲'],{'為'})['covered'],1)
        self.add('千','lushen','4')
        self.add('里','lushen','5')
        self.add('裏','lushen','6')
        value=query_text('千里',db_path=self.db_path)
        self.assertEqual(value['traditional'],'千里')
        self.assertEqual([c['char'] for c in value['characters'][1]['candidates']],['里'])

    def test_v1_extensions_keep_all_candidates_and_restriction(self):
        self.add('海','lushen','1')
        self.add('海','lushen','2')
        self.add('海','shufaziti','3')
        local = manifest(self.db)
        name = '颜真卿·多宝塔碑'
        self.assertIsInstance(local['chars']['海'][name],str)
        self.assertEqual(len(local['candidates']['海'][name]),3)
        # Even a malformed flag must not let a restricted origin into a
        # redistributable manifest.
        self.db.execute('UPDATE glyphs SET distributable=1 WHERE origin="shufaziti"')
        permitted = manifest(self.db,distributable=True)
        self.assertEqual(len(permitted['candidates']['海'][name]),2)
        self.assertNotIn('shufaziti',permitted['sources'][name]['origins'])

    def test_transparency_centering_and_pt_svg(self):
        bitmap=Image.new('RGB',(300,180),'white')
        ImageDraw.Draw(bitmap).rectangle((60,30,230,150),fill='black')
        buffer=io.BytesIO();bitmap.save(buffer,format='PNG')
        for data,is_svg in ((buffer.getvalue(),False),
            (b'<svg xmlns="http://www.w3.org/2000/svg" width="140pt" height="80pt"><path d="M20 20H100V60H20Z"/></svg>',True)):
            png,qa=normalize_png(data,svg=is_svg)
            result=Image.open(io.BytesIO(png))
            self.assertEqual(result.size,(256,256))
            self.assertEqual(result.mode,'RGBA')
            self.assertEqual(result.getpixel((0,0))[3],0)
            left,top,right,bottom=result.getbbox()
            self.assertGreaterEqual(min(left,top,256-right,256-bottom),25)
        with self.assertRaises(ValueError):
            normalize_png(b'<svg xmlns="http://www.w3.org/2000/svg"><image href="http://example.com/a"/></svg>',svg=True)

    def test_cache_has_no_network_and_rate_cannot_be_disabled(self):
        with self.assertRaises(ValueError): CachedHTTP(interval=1.19)
        cached=self.base/'cached.gif'
        cached.write_bytes(b'\xef\xbb\xbf{}')
        with patch('urllib.request.urlopen',side_effect=AssertionError('network forbidden')):
            client=CachedHTTP(offline=True)
            data,state=client.get('http://unreachable',cached,lambda data:json.loads(data.decode('utf-8-sig')))
            self.assertEqual(state,'cache')
            with self.assertRaises(RuntimeError):
                client.get('http://unreachable',self.base/'uncached.gif',lambda data:None)

    def test_attribution_never_invents_unknown_author_or_work(self):
        self.assertEqual(lushen_meta('楷-多宝塔')['calligrapher'],'颜真卿')
        self.assertEqual(lushen_meta('楷-赵孟俯三门记')['calligrapher'],'赵孟頫')
        self.assertEqual(source_metadata('行書-集字聖教序')['calligrapher'],'王羲之')
        self.assertEqual(source_metadata('神秘字体')['calligrapher'],'佚名')
        self.assertEqual(source_metadata('行書-米芾')['source_work'],'行书（未标作品）')
        self.add('海','mccd','name_fixture',author='文徵明')
        self.assertEqual(candidates(self.db,'海',calligrapher='文征明')[0]['calligrapher'],'文徵明')
        self.assertEqual(source_metadata('行書-文徵明')['calligrapher'],'文徵明')

    def test_cli_outputs_utf8_under_windows_gbk_environment(self):
        result=subprocess.run([sys.executable,str(ROOT/'query.py'),'𪚥','--db',str(self.db_path)],
                              capture_output=True,env={**os.environ,'PYTHONIOENCODING':'gbk'})
        self.assertEqual(result.returncode,0,result.stderr)
        value=json.loads(result.stdout.decode('utf8'))
        self.assertEqual(value['input'],'𪚥')


if __name__=='__main__': unittest.main()
