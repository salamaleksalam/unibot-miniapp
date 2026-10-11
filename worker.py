"""One scheduled MAX polling tick; durable SQLite image resides in the owner's Drive via GAS.

No Google Sheets, no Github-committed user database, no permanent daemon.
Long polling via MAX is intended for development; this is an explicitly delayed setup.
"""
import base64
import json
import logging
import os
import sqlite3
import tempfile
import time
from pathlib import Path

import requests

from . import bot, store
from .max_api import MaxClient, MaxFailure

log = logging.getLogger('radar.job')
logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s: %(message)s')


class StoreApiError(RuntimeError):
    pass


class SnapshotStore:
    def __init__(self, url, secret, session=None):
        if not url.startswith('https://script.google.com/macros/s/') or not url.endswith('/exec'):
            raise StoreApiError('Не задан HTTPS GAS_URL развернутого приложения (/exec)')
        if len(secret) < 48:
            raise StoreApiError('Неправильный GAS_SECRET')
        self.url = url
        self.secret = secret
        self.session = session or requests.Session()

    def call(self, action, **kwargs):
        request = {'action': action, 'secret': self.secret, **kwargs}
        try:
            r = self.session.post(self.url, json=request, timeout=(10,45))
            r.raise_for_status()
            data = r.json()
        except (requests.RequestException, ValueError) as exc:
            raise StoreApiError('Нет связи с хранилищем Apps Script (HTTPS/JSON)') from exc
        if not isinstance(data, dict) or not data.get('ok'):
            code = data.get('error') if isinstance(data, dict) else 'invalid_response'
            raise StoreApiError('Ошибка хранилища Apps Script: ' + str(code))
        return data

    def pull(self, db_path):
        data = self.call('pull')
        blob = data.get('blob', '')
        if not isinstance(blob, str) or not isinstance(data.get('revision'), int):
            raise StoreApiError('Неправильная форма ответа хранилища')
        try:
            binary = base64.b64decode(blob, validate=True)
        except (ValueError, base64.binascii.Error) as exc:
            raise StoreApiError('База данных испорчена: неверный base64') from exc
        if binary and not binary.startswith(b'SQLite format 3\x00'):
            raise StoreApiError('База данных испорчена: неверная сигнатура')
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)
        Path(db_path).write_bytes(binary)
        return data['revision']

    def push(self, db_path, revision):
        # SQLite WAL must be flushed before taking a binary snapshot.
        fd, backup_name = tempfile.mkstemp(prefix='radar-save-', suffix='.sqlite3')
        os.close(fd)
        try:
            with sqlite3.connect(db_path) as source, sqlite3.connect(backup_name) as target:
                source.backup(target)
            image = Path(backup_name).read_bytes()
        finally:
            Path(backup_name).unlink(missing_ok=True)
        if len(image) > 5 * 1024 * 1024:
            raise StoreApiError('База достигла ограничения 5 МБ; нужен другой способ хранения')
        blob = base64.b64encode(image).decode('ascii')
        data = self.call('push', revision=revision, blob=blob)
        return data['revision']


def _get_marker(db):
    db.execute('CREATE TABLE IF NOT EXISTS bot_cursor (id INTEGER PRIMARY KEY CHECK(id=1), marker TEXT)')
    row = db.execute('SELECT marker FROM bot_cursor WHERE id=1').fetchone()
    return row['marker'] if row else None


def _save_marker(db, marker):
    db.execute('INSERT INTO bot_cursor(id,marker) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET marker=excluded.marker',
               (str(marker),))


def _outbox_batch():
    """Reserve messages before calling external API; unknown deliveries aren't repeated."""
    t = store.now()
    with store.transaction() as db:
        # Crash-recovery: never resend uncertain messages automatically.
        recovered = db.execute("UPDATE outbox SET status='dead',lease_until=0 WHERE status='sending'").rowcount
        rows = db.execute("""SELECT id,user_id,kind,payload,attempts FROM outbox
           WHERE status='pending' AND next_at<=? ORDER BY id LIMIT 35""", (t,)).fetchall()
        ids = [r['id'] for r in rows]
        for rid in ids:
            db.execute("UPDATE outbox SET status='sending', attempts=attempts+1,lease_until=? WHERE id=?",(t+240, rid))
        return [dict(r) for r in rows], recovered


def _deliver(client, rows):
    delivered = []
    for row in rows:
        payload = json.loads(row['payload'])
        # Callback responses can expire during cron wait. Send a regular private message instead.
        if row['kind'] == 'answer':
            payload = payload.get('message') or {}
        try:
            client.send(row['user_id'], payload)
            delivered.append((row['id'], 'sent', 0))
        except MaxFailure as exc:
            # Timeout may mean success. Do not retry in that case.
            retry = exc.status == 429 and row['attempts'] < 4
            delivered.append((row['id'], 'pending' if retry else 'dead',
                              store.now() + (60 * (2**row['attempts'])) if retry else 0))
            log.warning('Сообщение #%s не отправлено; MAX HTTP %s', row['id'], exc.status)
        time.sleep(0.55)  # MAX API <= 2 outgoing messages/s/dialog.
    with store.transaction() as db:
        for rid,status,next_at in delivered:
            db.execute('UPDATE outbox SET status=?,next_at=?,lease_until=0 WHERE id=?',
                       (status,next_at,rid))
    return len([x for x in delivered if x[1] == 'sent'])


def run():
    required = ('MAX_BOT_TOKEN','GAS_URL','GAS_SECRET')
    missing = [name for name in required if not os.getenv(name)]
    if missing:
        raise RuntimeError('Отсутствуют секреты GitHub Actions: ' + ', '.join(missing))
    api = SnapshotStore(os.environ['GAS_URL'], os.environ['GAS_SECRET'])
    revision = api.pull(store.DATABASE)
    store.init()
    client = MaxClient(os.environ['MAX_BOT_TOKEN'])
    subs = client.request('GET','/subscriptions').get('subscriptions',[])
    if subs:
        # Выбран режим только личного бота без предыдущего webhook и мини-приложения.
        for sub in subs:
            old_url = sub.get('url','') if isinstance(sub,dict) else ''
            if not old_url.startswith('https://'):
                raise RuntimeError('MAX вернул некорректную подписку webhook')
            client.request('DELETE','/subscriptions',{'url':old_url})
        log.info('Отключены прежние webhook-подписки: %d',len(subs))
    with store.transaction() as db:
        marker = _get_marker(db)
    params = {'timeout':0,'limit':100}
    if marker is not None:
        params['marker'] = marker
    data = client.request('GET','/updates', params)
    updates = data.get('updates')
    if not isinstance(updates,list):
        raise RuntimeError('MAX не вернул список updates')
    next_marker = data.get('marker')
    changed = bool(updates) or (next_marker is not None and str(next_marker) != str(marker))
    with store.transaction() as db:
        _get_marker(db)
        for update in updates:
            if not isinstance(update, dict):
                raise RuntimeError('Некорректное событие от MAX')
            bot.handle_update(db,update)
        if changed and next_marker is not None:
            _save_marker(db,next_marker)
    # Persist updates and scheduled messages BEFORE any external sends.
    if changed:
        revision = api.push(store.DATABASE,revision)
    rows, recovered = _outbox_batch()
    if rows:
        # Write 'sending' to durable Drive before triggering MAX API; no duplicates on crash.
        revision = api.push(store.DATABASE,revision)
        total = _deliver(client,rows)
        revision = api.push(store.DATABASE,revision)
    else:
        if recovered:
            api.push(store.DATABASE,revision)
        total = 0
    log.info('Событий: %d; исходящих сообщений: %d; состояние сохранено',len(updates),total)


if __name__=='__main__':
    run()
