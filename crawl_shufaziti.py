"""Protocol-locked czj downloader; cached requests never hit the network."""
from __future__ import annotations

import argparse
import io
import json
import sys
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

from jizi_data import ROOT, S2T, T2S, han_chars, normalize_png, open_db, put_glyph, write_json, sha256, traditional_variants, normalize_calligrapher

BASE = 'http://jimei.shufaziti.com'
UA = 'AI-Jizi-LocalResearch/0.1 (local development only; minimum interval 1.2 seconds)'
CACHE = ROOT / 'data' / 'cache' / 'shufaziti'

# Unknown work titles stay explicit, rather than inventing a particular rubbing.
SOURCE_MAP = {
    '顏真卿多寶塔體': ('颜真卿', '多宝塔碑', '楷书', '唐'),
    '趙孟頫三門記體': ('赵孟頫', '三门记', '楷书', '元'),
    '行書-集字聖教序': ('王羲之', '集字圣教序', '行书', '东晋'),
    '顏家廟碑': ('颜真卿', '颜氏家庙碑', '楷书', '唐'),
    '張猛龍碑': ('佚名', '张猛龙碑', '楷书', '北魏'),
    '魏碑': ('佚名', '魏碑（未标作品）', '楷书', '北魏'),
    '標楷體-手寫': ('佚名', '标楷体手写', '楷书', ''),
}
DYNASTY = {'王羲之':'东晋', '颜真卿':'唐', '虞世南':'唐', '柳公权':'唐', '欧阳询':'唐',
           '褚遂良':'唐', '智永':'隋', '米芾':'宋', '苏轼':'宋', '赵孟頫':'元',
           '文徵明':'明', '张即之':'宋', '傅山':'明清', '赵之谦':'清', '郑板桥':'清',
           '伊秉绶':'清', '金农':'清', '邓石如':'清', '何绍基':'清', '王铎':'明清',
           '沈尹默':'近现代', '王壮为':'近现代'}


def source_metadata(label):
    if label in SOURCE_MAP:
        author, work, style, dynasty = SOURCE_MAP[label]
    else:
        simple = T2S.convert(label)
        style, name = ('', simple)
        if '-' in simple:
            prefix, name = simple.split('-', 1)
            style = {'行书':'行书','隶书':'隶书','草书':'草书','篆书':'篆书','楷书':'楷书'}.get(prefix, '')
        small = name.endswith('小字')
        author = normalize_calligrapher(name[:-2] if small else name)
        if author not in DYNASTY:
            author, work = '佚名', simple + '（上游未明确书家）'
        else:
            work = ('小字' if small else style or '书法') + '（未标作品）'
        dynasty = DYNASTY.get(author, '')
    return dict(calligrapher=author, source_work=work, style=style, dynasty=dynasty)


class CachedHTTP:
    def __init__(self, *, interval=1.25, offline=False):
        if interval < 1.2:
            raise ValueError('request interval must be >= 1.2 seconds')
        self.interval, self.offline = interval, offline
        CACHE.mkdir(parents=True, exist_ok=True)
        self.log = CACHE / 'requests.jsonl'
        self.last = 0.0
        if self.log.exists():
            lines = self.log.read_text(encoding='utf8').splitlines()
            if lines:
                self.last = json.loads(lines[-1])['started_at']

    def get(self, url, file: Path, validator):
        if file.exists():
            data=file.read_bytes()
            validator(data)
            meta=file.with_suffix(file.suffix+'.meta.json')
            if meta.exists() and sha256(data)!=json.loads(meta.read_text(encoding='utf8'))['sha256']:
                raise ValueError('cached file SHA256 mismatch: '+file.name)
            return data, 'cache'
        absent = file.with_suffix(file.suffix + '.missing.json')
        if absent.exists():
            return None, 'cached_404'
        if self.offline:
            raise RuntimeError('offline cache miss: ' + file.name)
        for attempt in range(4):
            time.sleep(max(0, self.last + self.interval - time.time()))
            self.last = time.time()
            record = dict(url=url, started_at=self.last, attempt=attempt+1)
            try:
                with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent':UA}), timeout=40) as response:
                    data = response.read(16_000_001)
                    record['status'] = response.status
                if len(data) > 16_000_000:
                    raise ValueError('response too large')
                validator(data)
                temp = file.with_suffix(file.suffix + '.part')
                temp.write_bytes(data)
                temp.replace(file)
                write_json(file.with_suffix(file.suffix+'.meta.json'),
                           dict(url=url, sha256=sha256(data), fetched_at=self.last))
                return data, 'download'
            except urllib.error.HTTPError as error:
                record['status'] = error.code
                if error.code == 404:
                    write_json(absent, record)
                    return None, '404'
                if error.code in (401,403):
                    raise RuntimeError('server denied access; stop crawl') from error
                if attempt == 3:
                    raise
            except Exception as error:
                record['error'] = str(error)
                if attempt == 3:
                    raise
            finally:
                with self.log.open('a', encoding='utf8') as out:
                    out.write(json.dumps(record, ensure_ascii=False) + '\n')
            time.sleep(2 ** (attempt+1))


def validate_index(data):
    index = json.loads(data.decode('utf-8-sig'))
    if not isinstance(index, dict) or any(not isinstance(ids,list) or
        any(not isinstance(i,int) or i < 0 for i in ids) for ids in index.values()):
        raise ValueError('unexpected czj index')


def validate_zip(data):
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        if len(archive.infolist()) > 5000 or sum(i.file_size for i in archive.infolist()) > 100_000_000:
            raise ValueError('oversized ZIP')
        if archive.testzip() is not None:
            raise ValueError('ZIP checksum failure')


def crawl(chars, *, offline=False, interval=1.25):
    client, db = CachedHTTP(interval=interval, offline=offline), open_db()
    report_path = ROOT/'output/b1_b2/crawl_report.json'
    report = json.loads(report_path.read_text(encoding='utf8')) if report_path.exists() else {}
    report.update(origin='shufaziti',local_only=True,minimum_request_interval=interval,
                  current_requested=chars,requested=list(dict.fromkeys(report.get('requested',[])+chars)))
    report.setdefault('characters',{})
    report['errors'] = [e for e in report.get('errors',[]) if e.get('char') not in chars]
    mappings = {}
    try:
        for count, char in enumerate(chars, 1):
            dec = str(ord(char))
            if len(dec) < 5:
                report['errors'].append({'char':char,'error':'protocol needs 5-digit codepoint'})
                continue
            index, state = client.get(f'{BASE}/datafile/czj/dat/{dec[4]}/{dec}.gif',
                                      CACHE / (dec+'.gif'), validate_index)
            if index is None:
                for variant in traditional_variants(char)[1:]:
                    dec = str(ord(variant))
                    index, state = client.get(f'{BASE}/datafile/czj/dat/{dec[4]}/{dec}.gif',
                                              CACHE / (dec+'.gif'), validate_index)
                    if index is not None:
                        break
            if index is None:
                report['characters'][char] = {'status':state,'glyphs':0}
                continue
            index = json.loads(index.decode('utf-8-sig'))
            packed, zip_state = client.get(f'{BASE}/datafile/czj/zipp/{dec[-1]}/{dec}.zip2',
                                           CACHE / (dec+'.zip2'), validate_zip)
            if packed is None:
                report['characters'][char] = {'status':zip_state,'glyphs':0}
                continue
            good = 0
            with zipfile.ZipFile(io.BytesIO(packed)) as archive:
                for label, ids in index.items():
                    meta = source_metadata(label)
                    mappings[label] = meta
                    for resource in ids:
                        key = f'{dec}/{resource}/{label}'
                        path = ROOT / 'glyphs_shufaziti' / dec / (str(resource)+'.png')
                        try:
                            if not path.exists():
                                png, qa = normalize_png(archive.read(str(resource)+'.svg'), svg=True)
                                path.parent.mkdir(parents=True,exist_ok=True)
                                path.write_bytes(png)
                            put_glyph(db, char=chr(int(dec)), image_path=path, origin='shufaziti',
                                      upstream_id=key, upstream_label=label, **meta)
                            good += 1
                        except Exception as error:
                            report['errors'].append({'char':char,'id':resource,'label':label,'error':str(error)})
            db.commit()
            report['characters'][char] = {'status':state,'zip_status':zip_state,'glyphs':good,
                                          'upstream_char':chr(int(dec))}
            write_json(ROOT/'output/b1_b2/crawl_report.json', report)
            print(f'czj {count}/{len(chars)} {char}: {good} glyphs ({state})', flush=True)
    finally:
        db.close()
        write_json(ROOT/'output/b1_b2/crawl_report.json', report)
        existing = ROOT/'docs/shufaziti_source_map.json'
        all_mappings = json.loads(existing.read_text(encoding='utf8')) if existing.exists() else {}
        all_mappings.update(mappings)
        write_json(existing, all_mappings)
    return report


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--text-file', type=Path, default=ROOT/'test_texts.txt')
    parser.add_argument('--offline', action='store_true')
    parser.add_argument('--interval', type=float, default=1.25)
    parser.add_argument('--limit',type=int,help='bounded batch from the specified text file')
    args = parser.parse_args()
    chars=han_chars(S2T.convert(args.text_file.read_text(encoding='utf8')))
    if args.limit is not None:
        if args.limit<1: parser.error('--limit must be positive')
        chars=chars[:args.limit]
    initial=set(han_chars(S2T.convert((ROOT/'test_texts.txt').read_text(encoding='utf8'))))
    if set(chars)-initial:
        quality_path=ROOT/'output/b1_b2/phase1_quality.json'
        if not quality_path.exists() or not json.loads(quality_path.read_text(encoding='utf8')).get('passed'):
            parser.error('expansion requires successful test81 quality report first')
    from filelock import FileLock
    CACHE.mkdir(parents=True,exist_ok=True)
    with FileLock(str(CACHE/'crawl.lock'),timeout=0):
        crawl(chars,offline=args.offline, interval=args.interval)
