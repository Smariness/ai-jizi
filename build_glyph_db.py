"""Incremental labelled imports + v1 manifest and measured coverage report."""
from __future__ import annotations

import argparse
import concurrent.futures
import json
import sys
import time
import zipfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from jizi_data import (ROOT, SIX, S2T, T2S, han_chars, normalize_png, open_db,
                       put_glyph, sha256, source_name, write_json, traditional_variants,
                       expand_label_aliases, candidates, AMBIGUOUS_S2T, normalize_calligrapher)

DOWNLOADS = {
    'armcd': '1Kuuj5VUX-2rJMiYmAp8aNh_ZUGez9WM3',
    'lushen_characters': '1LeLbQGhCFLYJakQIjioZh4D9bD2izBSN',
    'lushen_calligraphers': '1XznQ_wCSU3QvxnT5W5LeCZw4uF92FOcU',
}
LUSHEN_MAP = {
    '楷-多宝塔': ('颜真卿','多宝塔碑','楷书','唐'),
    '楷-赵孟俯三门记': ('赵孟頫','三门记','楷书','元'),
    '行-集字圣教序': ('王羲之','集字圣教序','行书','东晋'),
    '楷-魏碑': ('佚名','魏碑（未标作品）','楷书','北魏'),
}
DYNASTY = {'张即之':'宋','智永':'隋','柳公权':'唐','沈尹默':'近现代','虞世南':'唐',
           '赵之谦':'清','傅山':'明清','王壮为':'近现代','王铎':'明清','米芾':'宋',
           '郑板桥':'清','伊秉绶':'清','何绍基':'清','邓石如':'清','金农':'清'}


def lushen_meta(label):
    if label in LUSHEN_MAP:
        author, work, style, dynasty = LUSHEN_MAP[label]
    else:
        prefix, author = label.split('-',1)
        if author not in DYNASTY:
            raise ValueError('unmapped upstream author: '+label)
        style = {'楷':'楷书','行':'行书','隶':'隶书'}[prefix]
        work, dynasty = style+'（未标作品）', DYNASTY[author]
    return dict(calligrapher=author,source_work=work,style=style,dynasty=dynasty)


def download_archives():
    import gdown
    folder = ROOT/'data/raw'
    folder.mkdir(parents=True,exist_ok=True)
    path = ROOT/'output/b1_b2/download_report.json'
    report = json.loads(path.read_text(encoding='utf8')) if path.exists() else {}
    for name, resource in DOWNLOADS.items():
        target = folder/(name+'.zip')
        if target.exists() and zipfile.is_zipfile(target):
            status = 'cached'
        else:
            print('Downloading '+name,flush=True)
            part = folder/(name+'.zip.part')
            try:
                if not gdown.download(id=resource,output=str(part),quiet=True,resume=True):
                    raise RuntimeError('download returned no file')
                if not zipfile.is_zipfile(part):
                    raise ValueError('download did not contain a ZIP dataset')
                part.replace(target)
                status = 'downloaded'
            except Exception as error:
                report[name] = {'status':'unavailable','url':'https://drive.google.com/file/d/'+resource+'/view',
                                'error':str(error),'checked_at':time.time()}
                print(name+': '+str(error),flush=True)
                write_json(path,report)
                continue
        # Streaming hash, including raw archives in the provenance record.
        import hashlib
        digest = hashlib.sha256()
        with target.open('rb') as stream:
            for chunk in iter(lambda:stream.read(1024*1024),b''): digest.update(chunk)
        report[name] = {'status':status,'url':'https://drive.google.com/file/d/'+resource+'/view',
                        'path':target.as_posix(),'bytes':target.stat().st_size,'sha256':digest.hexdigest()}
        write_json(path,report)
    return report


def import_lushen(db, *, limit=None, workers=8):
    jpg_path, gif_path = (ROOT/'data/raw'/n for n in ('lushen_characters.zip','lushen_calligraphers.zip'))
    if not jpg_path.exists() or not gif_path.exists():
        return {'status':'missing_archive','images':0}
    report = {'status':'importing','images':0,'errors':[],'label_mismatches':[],'unknown_authors':0}
    labels = {}
    # The upstream ZIPs use GBK without ZIP's UTF-8 flag, not CP437.
    with zipfile.ZipFile(gif_path,metadata_encoding='gbk') as gifs:
        for info in gifs.infolist():
            if info.filename.lower().endswith('.gif'):
                _, author, char, filename = info.filename.split('/')
                key = Path(filename).stem
                if key in labels and labels[key] != (author,char):
                    raise ValueError('upstream ID has inconsistent author/char annotations: '+key)
                labels[key] = (author,char)
    report['author_archive_images'] = len(labels)
    report['upstream_author_labels'] = sorted({a for a,c in labels.values()})
    write_json(ROOT/'docs/lushen_source_map.json', {label:lushen_meta(label) for label in report['upstream_author_labels']})
    existing = {row[0]: row[1] for row in db.execute('SELECT upstream_id,image_path FROM glyphs WHERE origin="lushen"')}
    def render_job(job):
        key, raw_char, label, meta, path, data = job
        try:
            png, qa = normalize_png(data)
            path.parent.mkdir(parents=True,exist_ok=True)
            path.write_bytes(png)
            return (dict(char=raw_char,image_path=path,origin='lushen',
                         upstream_id=key,upstream_label=label+' / '+raw_char,
                         image_sha256=sha256(png),**meta),None)
        except Exception as error:
            return None, {'id':key,'error':str(error)}

    with zipfile.ZipFile(jpg_path,metadata_encoding='gbk') as jpgs, \
         concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        entries = [i for i in jpgs.infolist() if i.filename.lower().endswith('.jpg')]
        report['character_archive_images'] = len(entries)
        report['raw_character_classes'] = len({i.filename.split('/')[-2] for i in entries})
        pending = []

        def flush():
            for record, error in pool.map(render_job, pending):
                if error: report['errors'].append(error)
                else:
                    put_glyph(db,**record)
                    report['images'] += 1
            pending.clear()
            db.commit()

        for number, info in enumerate(entries,1):
            if limit and number > limit: break
            _, raw_char, filename = info.filename.split('/')
            key = Path(filename).stem
            if len(raw_char) != 1 or len(S2T.convert(raw_char)) != 1:
                report['errors'].append({'member':info.filename,'error':'not a single character'})
                continue
            label, author_char = labels.get(key, ('',raw_char))
            if author_char != raw_char:
                report['label_mismatches'].append({'id':key,'jpg_char':raw_char,'gif_char':author_char})
                continue
            if label:
                meta = lushen_meta(label)
            else:
                report['unknown_authors'] += 1
                meta = dict(calligrapher='佚名',source_work='上游未标书家与作品',style='',dynasty='')
            path = ROOT/'glyph_images/lushen'/f'{key}.png'
            try:
                if key in existing and (ROOT/existing[key]).exists():
                    report['images'] += 1
                else:
                    pending.append((key,raw_char,label,meta,path,jpgs.read(info)))
            except Exception as error:
                report['errors'].append({'member':info.filename,'error':str(error)})
            if len(pending) >= 256 or number % 1000 == 0:
                flush()
            if number % 1000 == 0:
                print(f'lushen {number}/{len(entries)}',flush=True)
                write_json(ROOT/'output/b1_b2/lushen_import_report.json',report)
        flush()
    db.commit()
    report['status'] = 'complete' if not limit else 'sample_only'
    write_json(ROOT/'output/b1_b2/lushen_import_report.json',report)
    return report


def import_labelled_archive(db, archive_path, annotation_path, origin='armcd'):
    """Explicit JSONL annotations; numeric restoration filenames are not labels.

    Fields: member, char, calligrapher, source_work, style, dynasty.
    Also supports future MCCD append via --labelled-origin mccd; upserts are
    origin-scoped and cannot remove or overwrite other sources.
    """
    report = {'status':'complete','images':0,'errors':[]}
    with zipfile.ZipFile(archive_path,metadata_encoding='gbk') as archive:
        for line in Path(annotation_path).read_text(encoding='utf8').splitlines():
            if not line.strip(): continue
            item = json.loads(line)
            member = item['member']
            try:
                if len(item['char']) != 1 or not item['calligrapher'] or not item['source_work']:
                    raise ValueError('character, author and work annotation required')
                path = ROOT/'glyph_images'/origin/(sha256(member.encode('utf8'))[:24]+'.png')
                if not path.exists():
                    png, qa = normalize_png(archive.read(member))
                    path.parent.mkdir(parents=True,exist_ok=True)
                    path.write_bytes(png)
                put_glyph(db,char=item['char'],image_path=path,origin=origin,upstream_id=member,
                          upstream_label=item['char'],calligrapher=normalize_calligrapher(item['calligrapher']),
                          source_work=T2S.convert(item['source_work']),style=item.get('style',''),dynasty=item.get('dynasty',''))
                report['images'] += 1
            except Exception as error:
                report['errors'].append({'member':member,'error':str(error)})
    db.commit()
    write_json(ROOT/f'output/b1_b2/{origin}_import_report.json',report)
    return report


def manifest(db, *, distributable=False):
    where = " WHERE distributable=1 AND origin IN ('armcd','lushen')" if distributable else ''
    result = {'format':'glyph-manifest-v1','edition':'real-local' if not distributable else 'real-redistributable',
              'local_only':not distributable,'normalization':'raw upstream labels retained; OpenCC s2t input aliases; ambiguous one-to-many labels never relabelled',
              'image_size':256,'chars':{},'sources':{},'candidates':{},'aliases':{}}
    for row in db.execute('SELECT * FROM glyphs'+where+' ORDER BY char,calligrapher,source_work,origin,upstream_id'):
        char, name = row['char'], source_name(row)
        # Primary maps stay exactly v1: char -> source -> PNG string.
        # All alternatives and provenance are preserved in optional extensions.
        result['chars'].setdefault(char,{}).setdefault(name,row['image_path'])
        result['candidates'].setdefault(char,{}).setdefault(name,[]).append(
            {'id':row['id'],'path':row['image_path'],'origin':row['origin'],
             'raw_char':row['char'],'upstream_id':row['upstream_id'],'distributable':bool(row['distributable'])})
        source = result['sources'].setdefault(name,dict(calligrapher=row['calligrapher'],source_work=row['source_work'],
                                             style=row['style'],dynasty=row['dynasty'],origins=[]))
        if row['origin'] not in source['origins']: source['origins'].append(row['origin'])
    for raw in list(result['chars']):
        converted=S2T.convert(raw)
        if raw==converted or raw in AMBIGUOUS_S2T: continue
        for name,image in result['chars'][raw].items():
            result['chars'].setdefault(converted,{}).setdefault(name,image)
            items=result['candidates'].setdefault(converted,{}).setdefault(name,[])
            known={item['id'] for item in items}
            items.extend(item for item in result['candidates'][raw][name] if item['id'] not in known)
    # Compatibility aliases for simplified input. Do not conflate canonical
    # glyph classes: aliases are explicit, canonical chars always take priority.
    pool = han_chars((ROOT/'test_texts.txt').read_text(encoding='utf8'))
    common = ROOT/'data/upstream/common3500.txt'
    if common.exists(): pool += han_chars(common.read_text(encoding='utf8'))
    for char in dict.fromkeys(pool):
        converted = S2T.convert(char)
        match = next((c for c in traditional_variants(converted) if c in result['chars']),None)
        if char not in result['chars'] and match:
            result['chars'][char] = result['chars'][match]
            result['aliases'][char] = match
        if converted not in result['chars'] and match:
            result['chars'][converted] = result['chars'][match]
            result['aliases'][converted] = match
    return result


def coverage(targets, present):
    present=expand_label_aliases(present)
    missing = [c for c in targets if not any(v in present for v in traditional_variants(c))]
    return {'total':len(targets),'covered':len(targets)-len(missing),
            'rate':round((len(targets)-len(missing))/len(targets),6) if targets else 0,
            'missing':missing}


def make_samples(db):
    rows = []
    targets = han_chars(S2T.convert((ROOT/'test_texts.txt').read_text(encoding='utf8')))
    # Reproducible 10 samples of each available live source across distinct chars.
    for origin in ('armcd','lushen','shufaziti'):
        seen, authors = set(), set()
        for char in targets:
            available = candidates(db,char,origin=origin,normalized=True)
            row = next((r for r in available if r['calligrapher'] not in authors),None)
            if row is None and available: row = available[0]
            if row and char not in seen:
                rows.append(dict(row));seen.add(char);authors.add(row['calligrapher'])
            if len(seen) >= 10: break
    folder = ROOT/'output/b1_b2/samples'
    folder.mkdir(parents=True,exist_ok=True)
    sheet = Image.new('RGB',(5*280,((len(rows)+4)//5)*310),(248,247,241))
    draw = ImageDraw.Draw(sheet)
    font = ImageFont.truetype(str(ROOT/'fonts/LXGWWenKai-Regular.ttf'),16)
    evidence = []
    for i,row in enumerate(rows):
        path = ROOT/row['image_path']
        image = Image.open(path).convert('RGBA')
        sample = folder/f'{i+1:02}_{row["origin"]}_U{ord(row["char"]):04X}.png'
        image.save(sample)
        x,y = (i%5)*280,(i//5)*310
        sheet.paste(image,(x+12,y+10),image)
        draw.text((x+12,y+267),row['char']+' / '+row['origin'],font=font,fill='black')
        draw.text((x+12,y+287),source_name(row),font=font,fill='black')
        evidence.append({'sample_path':sample.as_posix(),'id':row['id'],'char':row['char'],
                         'source':source_name(row),'origin':row['origin'],'original_path':path.as_posix()})
    if rows: sheet.save(folder/'contact_sheet.png')
    write_json(folder/'index.json',evidence)
    return evidence


def outputs(db):
    raw_text = (ROOT/'test_texts.txt').read_text(encoding='utf8')
    raw_chars, test_chars = han_chars(raw_text), han_chars(S2T.convert(raw_text))
    common_raw = han_chars((ROOT/'data/upstream/common3500.txt').read_text(encoding='utf8'))
    if len(common_raw) != 3500: raise ValueError('common character list must contain exactly 3500 unique characters')
    common_trad = [S2T.convert(c) for c in common_raw]
    report = {'format':'glyph-build-report-v1','generated_at':time.strftime('%Y-%m-%dT%H:%M:%S%z'),
              'requested_origins':['armcd','lushen','shufaziti'],'three_sources_complete':False,
              'test_texts':{'raw_unique_count':len(raw_chars),'traditional_unique_count':len(test_chars),
                            'raw_chars':raw_chars,'traditional_chars':test_chars},
              'common3500':{'definition':'通用规范汉字表(2013)一级字表；逐字 OpenCC s2t',
                            'raw_total':3500,'traditional_unique_total':len(set(common_trad)),
                            'list_sha256':sha256((ROOT/'data/upstream/common3500.txt').read_bytes()),
                            'transcription_url':'https://github.com/shengdoushi/common-standard-chinese-characters-table'},
              'origins':{},'six_calligraphers':{}}
    for origin in report['requested_origins']:
        present = {r[0] for r in db.execute('SELECT DISTINCT char FROM glyphs WHERE origin=?',(origin,))}
        count = db.execute('SELECT count(*) FROM glyphs WHERE origin=?',(origin,)).fetchone()[0]
        report['origins'][origin] = {'images':count,'distinct_characters':len(present),
              'calligraphers':[r[0] for r in db.execute('SELECT DISTINCT calligrapher FROM glyphs WHERE origin=? ORDER BY calligrapher',(origin,))],
              'test81':coverage(test_chars,present),'common3500':coverage(common_trad,present),
              'local_only':origin=='shufaziti','status':'available' if count else 'unavailable'}
    union = {r[0] for r in db.execute('SELECT DISTINCT char FROM glyphs')}
    report['union'] = {'images':db.execute('SELECT count(*) FROM glyphs').fetchone()[0],
                      'distinct_characters':len(union),'test81':coverage(test_chars,union),
                      'common3500':coverage(common_trad,union)}
    six_union = set()
    for author in SIX:
        present = {r[0] for r in db.execute('SELECT DISTINCT char FROM glyphs WHERE calligrapher=?',(author,))}
        six_union |= present
        report['six_calligraphers'][author] = {'test81':coverage(test_chars,present),'common3500':coverage(common_trad,present)}
    six_known=expand_label_aliases(six_union)
    report['six_union'] = {'calligraphers':list(SIX),'test81':coverage(test_chars,six_union),
                           'common3500':coverage(common_trad,six_union),
                           'missing_common3500_pairs':[{'simplified':s,'traditional':t}
                              for s,t in zip(common_raw,common_trad)
                              if not any(v in six_known for v in traditional_variants(t))]}
    download = ROOT/'output/b1_b2/download_report.json'
    report['downloads'] = json.loads(download.read_text(encoding='utf8')) if download.exists() else {}
    availability=ROOT/'output/b1_b2/armcd_availability.json'
    report['armcd_availability'] = json.loads(availability.read_text(encoding='utf8')) if availability.exists() else []
    report['blockers'] = []
    if not report['origins']['armcd']['images']:
        report['blockers'].append({'origin':'armcd','reason':'Upstream Drive file is unavailable (404); archive and per-image annotations could not be verified.',
            'download_script':'data/upstream/armcd_download.py','evidence':'output/b1_b2/armcd_availability.json',
            'upstream_issue':'https://github.com/lhl322001/ARMCD/issues/2'})
    for name in ('armcd','lushen','crawl'):
        path = ROOT/f'output/b1_b2/{name}_import_report.json' if name!='crawl' else ROOT/'output/b1_b2/crawl_report.json'
        if path.exists():
            detail = json.loads(path.read_text(encoding='utf8'))
            report[name+'_import'] = {k:v for k,v in detail.items() if k!='characters'}
    report['three_sources_complete'] = all(x['images'] for x in report['origins'].values())
    report['sample_images'] = make_samples(db)
    for permitted, name in ((False,'glyph_manifest_real.json'),(True,'glyph_manifest_distributable.json')):
        value = manifest(db,distributable=permitted)
        write_json(ROOT/'docs'/name,value)
    write_json(ROOT/'build_report.json',report)
    print(json.dumps({'images':report['union']['images'],'origins':{k:v['images'] for k,v in report['origins'].items()},
                      'test81':report['union']['test81'],'three_sources_complete':report['three_sources_complete']},ensure_ascii=False),flush=True)
    return report


def restore_upstream_labels(db):
    """Recover literal labels from old import checkpoints; never infer glyph identity.

    A single-character s2t on database labels loses context (里 -> 裏). Keep
    the upstream label unchanged and use a separate, conservative alias index.
    """
    changed=[]
    for row in db.execute('SELECT id,char,origin,upstream_id,upstream_label FROM glyphs'):
        if row['origin']=='lushen' and ' / ' in row['upstream_label']:
            raw=row['upstream_label'].rsplit(' / ',1)[1]
        elif row['origin']=='shufaziti':
            raw=chr(int(row['upstream_id'].split('/')[0]))
        else: continue
        if len(raw)==1 and raw!=row['char']: changed.append((raw,row['id']))
    db.executemany('UPDATE glyphs SET char=? WHERE id=?',changed)
    db.executemany('INSERT OR REPLACE INTO character_aliases VALUES(?,?,?)',
        [(r[0],S2T.convert(r[0]),int(r[0] not in AMBIGUOUS_S2T))
         for r in db.execute('SELECT DISTINCT char FROM glyphs').fetchall()])
    db.commit()
    return len(changed)


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--download',action='store_true')
    parser.add_argument('--skip-lushen',action='store_true')
    parser.add_argument('--sample-limit',type=int)
    parser.add_argument('--workers',type=int,default=8,choices=range(1,33))
    parser.add_argument('--labelled-archive',type=Path)
    parser.add_argument('--annotations',type=Path)
    parser.add_argument('--labelled-origin',choices=('armcd','mccd'),default='armcd')
    args = parser.parse_args()
    if bool(args.labelled_archive) != bool(args.annotations): parser.error('archive and annotations are required together')
    if args.download: download_archives()
    with open_db() as db:
        if not args.skip_lushen: import_lushen(db,limit=args.sample_limit,workers=args.workers)
        if args.labelled_archive: import_labelled_archive(db,args.labelled_archive,args.annotations,args.labelled_origin)
        restore_upstream_labels(db)
        # Reports and the two manifests describe a single database snapshot.
        db.execute('BEGIN')
        outputs(db)
