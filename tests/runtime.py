"""Disposable Docker test of real n8n persistence, webhook admission and resume races.
Only the ActionBox transport is replaced by runtime-fixture.cjs. No live credentials.
"""
import concurrent.futures
import hashlib
import hmac
import http.cookiejar
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[1]
IMAGE = 'docker.n8n.io/n8nio/n8n:2.38.7@sha256:a8c95f75c6fdf65f5f2b7a7b354744eaa1c62bb911b5c00af6499c3f38e4cd32'
name = 'actionbox-n8n-test-' + uuid.uuid4().hex[:8]

def docker(*args):
    return subprocess.check_output(['docker', *args], text=True).strip()

def wait_for(fn, timeout=90):
    end = time.monotonic() + timeout
    last = None
    while time.monotonic() < end:
        try:
            value = fn()
            if value:
                return value
        except (OSError, ValueError, KeyError) as exc:
            last = exc
        time.sleep(.5)
    raise AssertionError(f'Timed out: {last}')

with tempfile.TemporaryDirectory(prefix='actionbox-n8n-runtime-') as tmp:
    temp = Path(tmp)
    shutil.copytree(ROOT / 'dist', temp / 'product')
    (temp / 'fixture').mkdir()
    shutil.copyfile(ROOT / 'tests/runtime-fixture.cjs', temp / 'fixture/ActionBoxFixture.node.js')
    # Keep the node's relative icon references valid for n8n's loader.
    for icon in (ROOT / 'nodes/ActionBox').glob('*.svg'):
        shutil.copyfile(icon, temp / 'fixture' / icon.name)
    try:
        docker('run', '-d', '--name', name, '-p', '127.0.0.1::5678',
               '-v', f'{temp}/product:/opt/actionbox:ro', '-v', f'{temp}/fixture:/opt/fixture:ro',
               '-e', 'N8N_CUSTOM_EXTENSIONS=/opt/fixture', '-e', 'NODE_PATH=/usr/local/lib/node_modules/n8n/node_modules', '-e', 'N8N_WEBHOOK_URL=https://automation.example.test/',
               '-e', 'N8N_DIAGNOSTICS_ENABLED=false', '-e', 'N8N_VERSION_NOTIFICATIONS_ENABLED=false',
               '-e', 'N8N_TEMPLATES_ENABLED=false', '-e', 'N8N_SECURE_COOKIE=false',
               '-e', 'N8N_ENCRYPTION_KEY=fixture-encryption-key', IMAGE)
        port = docker('port', name, '5678/tcp').split(':')[-1]
        base = 'http://127.0.0.1:' + port
        jar = http.cookiejar.CookieJar()
        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
        def api(path, data=None, method=None, headers=None):
            req = urllib.request.Request(base + path, data=None if data is None else json.dumps(data).encode(), method=method, headers={'Content-Type': 'application/json', **(headers or {})})
            try:
                with opener.open(req, timeout=15) as response:
                    raw = response.read()
                    try:
                        body = json.loads(raw) if raw else {}
                    except ValueError:
                        body = raw.decode()
                    return response.status, body
            except urllib.error.HTTPError as exc:
                return exc.code, exc.read().decode()
        wait_for(lambda: api('/healthz/readiness')[0] == 200)
        status, body = api('/rest/owner/setup', {'email': 'fixture@example.com', 'firstName': 'Test', 'lastName': 'Owner', 'password': 'FixtureOnly12345!'} )
        assert status == 200, (status, body)
        def workflow(timeout=10):
            path = 'fixture-' + uuid.uuid4().hex
            payload = {'name': 'ActionBox runtime test', 'nodes': [
                {'id': 'trigger', 'name': 'Trigger', 'type': 'n8n-nodes-base.webhook', 'typeVersion': 2, 'position': [0,0], 'webhookId': path, 'parameters': {'httpMethod': 'POST', 'path': path, 'responseMode': 'onReceived', 'options': {}}},
                {'id': 'approval', 'name': 'Approval', 'type': 'CUSTOM.actionBoxFixture', 'typeVersion': 1, 'position': [200,0], 'parameters': {'resource':'action','operation':'requestApproval','title':'Fixture approval','description':'','priority':'normal','reviewerEmails':'','approveLabel':'Approve','rejectLabel':'Reject','timeoutMinutes':timeout}},
                {'id': 'end', 'name': 'End', 'type': 'n8n-nodes-base.noOp', 'typeVersion': 1, 'position': [400,0], 'parameters': {}}
            ], 'connections': {'Trigger': {'main': [[{'node':'Approval','type':'main','index':0}]]}, 'Approval': {'main': [[{'node':'End','type':'main','index':0}]]}}, 'settings': {'executionOrder':'v1', 'saveDataSuccessExecution':'all','saveDataErrorExecution':'all'}}
            status, body = api('/rest/workflows', payload)
            assert status == 200, (status, body)
            w = body['data']
            status, body = api('/rest/workflows/'+w['id']+'/activate', {'versionId':w['versionId']})
            assert status == 200, (status, body)
            return w['id'], path
        def executions(wid):
            _, body = api('/rest/executions?' + urllib.parse.urlencode({'filter':json.dumps({'workflowId':wid}), 'limit':'20'}))
            return body['data']['results']
        def detail(eid):
            _, body = api('/rest/executions/'+eid)
            data = body['data']
            # The API uses flatted serialization for execution data; decode in Node below.
            if isinstance(data.get('data'),str):
                source = 'const f=require("/usr/local/lib/node_modules/n8n/node_modules/flatted");process.stdout.write(JSON.stringify(f.parse(process.argv[1])))'
                data['data'] = json.loads(docker('exec', name, 'node', '-e', source, data['data']))
            return data
        def begin(timeout=10):
            wid,path=workflow(timeout)
            assert api('/webhook/'+path, {'order':'fixture'})[0] == 200
            row=wait_for(lambda: next((e for e in executions(wid) if e['status']=='waiting'),None))
            return wid, row['id']
        def callback_path(eid):
            data=detail(eid)['data']
            saved=data['executionData']['contextData']['node:Approval']['approval']
            url=urllib.parse.urlsplit(saved['payload']['callback_url'])
            return url.path+'?'+url.query
        def send(eid, path, event_type='action.resolved', bad=False, other=False):
            event={'id':'fixture-event','type':event_type,'data':{'action_id':'other' if other else 'fixture-'+eid}}
            raw=json.dumps(event).encode(); timestamp=str(int(time.time()))
            signature='v1='+hmac.new(b'fixture-signing-secret',timestamp.encode()+b'.'+raw,hashlib.sha256).hexdigest()
            headers={'x-actionbox-timestamp':timestamp,'x-actionbox-signature': 'v1' if bad else signature}
            status, body = api(path,event,headers=headers)
            return status
        wid,eid=begin(); path=callback_path(eid)
        assert send(eid,path,bad=True)>=400
        assert send(eid,path,other=True)>=400
        assert send(eid,path,event_type='action.context_requested')==200
        assert detail(eid)['status']=='waiting'
        docker('restart',name)
        port = docker('port', name, '5678/tcp').split(':')[-1]
        base = 'http://127.0.0.1:' + port
        wait_for(lambda: api('/healthz/readiness')[0] == 200)
        assert detail(eid)['status']=='waiting'
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            codes=list(pool.map(lambda _:send(eid,path),range(6)))
        final=wait_for(lambda: (d if (d:=detail(eid))['status']=='success' else None))
        ends=final['data']['resultData']['runData']['End']
        assert len(ends)==1, ends
        assert ends[0]['data']['main'][0][0]['json']['actionbox']['approved'] is True
        assert send(eid,path) in [200,404,409]
        print('PASS: invalid/nonterminal callbacks do not resume; restart + six duplicate callbacks produce one continuation',flush=True)
        wid,eid=begin(1); path=callback_path(eid)
        race_wid,race_eid=begin(1); race_path=callback_path(race_eid)
        race_deadline=detail(race_eid)['data']['executionData']['contextData']['node:Approval']['approval']['deadline']
        # A dropped callback times out via the real n8n timer, without executing our node again.
        final=wait_for(lambda: (d if (d:=detail(eid))['status']=='success' else None),timeout=150)
        output=final['data']['resultData']['runData']['End'][0]['data']['main'][0][0]['json']
        assert output['actionbox']['approved'] is False
        assert output['actionbox']['decision_status']=='timed_out'
        assert send(eid,path) in [200,404,409]
        print('PASS: missing callback times out safely; late callback cannot change the result',flush=True)
        wait_for(lambda: time.time()*1000 >= race_deadline, timeout=70)
        assert send(race_eid,race_path) in [200,404,409,500]
        race=wait_for(lambda: (d if (d:=detail(race_eid))['status']=='success' else None),timeout=90)
        ends=race['data']['resultData']['runData']['End']
        assert len(ends)==1
        assert ends[0]['data']['main'][0][0]['json']['actionbox']['approved'] is False
        assert 'Fixture: early callback rejected' in docker('logs',name)
        print('PASS: pre-persistence callback rejected; callback/deadline race produces one non-approval',flush=True)
    except Exception:
        print(docker('logs','--tail','35',name))
        raise
    finally:
        subprocess.run(['docker','rm','-f','-v',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
