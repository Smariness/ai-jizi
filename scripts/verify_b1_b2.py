"""Independent data audit; full PNG decode + SHA256 and offline query checks."""
import concurrent.futures
import io
import json
import sqlite3
import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from PIL import Image
from jizi_data import ROOT, SIX, han_chars, sha256, traditional_variants, write_json
from query import query_text


def verify_image(row):
    try:
        path=(ROOT/row['image_path']).resolve()
        if not path.is_relative_to(ROOT): raise ValueError('path outside project')
        data=path.read_bytes()
        if sha256(data)!=row['sha256']: raise ValueError('SHA256 mismatch')
        with Image.open(io.BytesIO(data)) as image:
            image.load()
            if image.size!=(256,256) or image.mode!='RGBA': raise ValueError('not 256x256 RGBA')
            alpha=image.getchannel('A')
            if alpha.getextrema()[0]!=0 or alpha.getextrema()[1]==0: raise ValueError('no transparency or ink')
            left,top,right,bottom=alpha.getbbox()
            if min(left,top,256-right,256-bottom)<25: raise ValueError('ink exceeds safe box')
        return None
    except Exception as error: return {'id':row['id'],'path':row['image_path'],'error':str(error)}


def main():
    report={'passed':False,'checks':{},'image_errors':[]}
    db=sqlite3.connect((ROOT/'glyphs.db').as_uri()+'?mode=ro',uri=True)
    db.row_factory=sqlite3.Row
    try:
        rows=[dict(r) for r in db.execute('SELECT * FROM glyphs')]
        report['checks']['sqlite_integrity']=db.execute('PRAGMA integrity_check').fetchone()[0]
        report['checks']['images']=len(rows)
        report['checks']['duplicate_keys']=db.execute('SELECT count(*) FROM (SELECT origin,upstream_id,count(*) n FROM glyphs GROUP BY origin,upstream_id HAVING n>1)').fetchone()[0]
        report['checks']['restricted_rows_marked_local']=not any(r['origin']=='shufaziti' and r['distributable'] for r in rows)
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            for number,error in enumerate(pool.map(verify_image,rows),1):
                if error: report['image_errors'].append(error)
                if number%20000==0: print(f'audit {number}/{len(rows)}',flush=True)
        manifest=json.loads((ROOT/'docs/glyph_manifest_real.json').read_text(encoding='utf8'))
        permitted=json.loads((ROOT/'docs/glyph_manifest_distributable.json').read_text(encoding='utf8'))
        report['checks']['manifest_format']=manifest['format']=='glyph-manifest-v1'
        mapped={(v['id'],v['path'],v['origin']) for sources in manifest['candidates'].values()
                for items in sources.values() for v in items}
        expected={(r['id'],r['image_path'],r['origin']) for r in rows}
        report['checks']['manifest_all_candidates']=mapped==expected
        report['checks']['distributable_manifest_no_restricted_origin']=all(
            v['origin'] in ('armcd','lushen') for sources in permitted['candidates'].values()
            for items in sources.values() for v in items)
        report['checks']['manifest_paths_are_strings']=all(isinstance(p,str) for v in manifest['chars'].values() for p in v.values())
        # Network calls are rejected while real SQLite queries run.
        with patch('urllib.request.urlopen',side_effect=AssertionError('offline query attempted network')):
            result=query_text('海内存知己',origin='lushen')
            report['checks']['offline_s2t_query']=result['traditional']=='海內存知己' and all(c['candidates'] for c in result['characters'])
            filtered=query_text('海',origin='shufaziti',calligrapher='顏真卿')
            report['checks']['combined_filters']=bool(filtered['characters'][0]['candidates']) and all(
                c['origin']=='shufaziti' and c['calligrapher']=='颜真卿' for c in filtered['characters'][0]['candidates'])
            missing=query_text('𪚥',origin='armcd')
            report['checks']['missing_is_explicit']=missing['characters'][0]['candidates']==[]
        log=ROOT/'data/cache/shufaziti/requests.jsonl'
        records=[json.loads(l) for l in log.read_text(encoding='utf8').splitlines()]
        gaps=[b['started_at']-a['started_at'] for a,b in zip(records,records[1:])]
        report['checks']['crawler_requests']=len(records)
        report['checks']['crawler_min_gap_seconds']=min(gaps) if gaps else None
        report['checks']['crawler_rate_passed']=all(gap>=1.2 for gap in gaps)
        build=json.loads((ROOT/'build_report.json').read_text(encoding='utf8'))
        report['checks']['build_report_counts_match']=build['union']['images']==len(rows) and all(
            build['origins'][origin]['images']==sum(r['origin']==origin for r in rows)
            for origin in ('armcd','lushen','shufaziti'))
        report['checks']['six_authors_reported']=set(build['six_calligraphers'])==set(SIX)
        report['three_sources_complete']=build['three_sources_complete']
        numeric=('images','crawler_requests','crawler_min_gap_seconds')
        report['passed']=not report['image_errors'] and all(value is True or
            (key=='sqlite_integrity' and value=='ok') or (key=='duplicate_keys' and value==0)
            for key,value in report['checks'].items() if key not in numeric)
        write_json(ROOT/'output/b1_b2/verification_report.json',report)
        print(json.dumps(report,ensure_ascii=False,indent=2))
        return 0 if report['passed'] else 1
    finally: db.close()


if __name__=='__main__': raise SystemExit(main())
