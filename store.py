"""SQLite storage. A single database and transactional outbox: no Google services."""
import csv
import os
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path

DATABASE = os.environ.get("DB_PATH", "/data/radar.sqlite3")
STATIONS_CSV = Path(__file__).resolve().parents[1] / "data" / "stations.csv"


def now():
    return int(time.time())


def connect():
    con = sqlite3.connect(DATABASE, timeout=20, isolation_level=None)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA busy_timeout=20000")
    con.execute("PRAGMA foreign_keys=ON")
    con.execute("PRAGMA journal_mode=WAL")
    return con


@contextmanager
def transaction():
    con = connect()
    try:
        con.execute("BEGIN IMMEDIATE")
        yield con
        con.commit()
    except Exception:
        con.rollback()
        raise
    finally:
        con.close()


def init():
    Path(DATABASE).parent.mkdir(parents=True, exist_ok=True)
    with transaction() as db:
        db.executescript("""
        CREATE TABLE IF NOT EXISTS stations (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, district TEXT NOT NULL,
          address TEXT NOT NULL, lat REAL, lon REAL
        );
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS reports (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          station_id TEXT NOT NULL REFERENCES stations(id), author_id TEXT NOT NULL REFERENCES users(id),
          kind TEXT NOT NULL, fuel TEXT NOT NULL DEFAULT '', value TEXT NOT NULL,
          created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS reports_station ON reports(station_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS reports_author ON reports(author_id, created_at DESC);
        CREATE TABLE IF NOT EXISTS votes (
          report_id INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          value INTEGER NOT NULL CHECK(value IN (-1,1)),
          PRIMARY KEY (report_id,user_id)
        );
        CREATE TABLE IF NOT EXISTS follows (
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          station_id TEXT NOT NULL REFERENCES stations(id),
          PRIMARY KEY (user_id,station_id)
        );
        CREATE TABLE IF NOT EXISTS states (
          user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          action TEXT NOT NULL, station_id TEXT NOT NULL DEFAULT '', fuel TEXT NOT NULL DEFAULT '',
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS processed (
          event_key TEXT PRIMARY KEY, created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS outbox (
          id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL,
          kind TEXT NOT NULL, payload TEXT NOT NULL,
          dedupe_key TEXT UNIQUE, status TEXT NOT NULL DEFAULT 'pending',
          attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0,
          lease_until INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(status,next_at,id);
        """)
        rows = list(csv.DictReader(STATIONS_CSV.open(encoding="utf-8-sig", newline="")))
        if len(rows) != 73 or len({r['ID'] for r in rows}) != 73:
            raise ValueError("Исходный справочник должен содержать 73 уникальные АЗС")
        for r in rows:
            db.execute("""INSERT INTO stations(id,name,district,address,lat,lon)
              VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
              name=excluded.name,district=excluded.district,address=excluded.address,
              lat=CASE WHEN excluded.lat IS NOT NULL THEN excluded.lat ELSE stations.lat END,
              lon=CASE WHEN excluded.lon IS NOT NULL THEN excluded.lon ELSE stations.lon END""",
              (r['ID'], r['Название'].strip(), r['Район Оренбурга'].strip(),r['Адрес'].strip(),
               float(r['Широта']) if r['Широта'].strip() else None,
               float(r['Долгота']) if r['Долгота'].strip() else None))
        # Keep *all* existing reports, subscriptions and votes on redeploy.


def user_upsert(db, uid, name):
    t = now()
    db.execute("""INSERT INTO users (id,name,active,created_at,last_seen) VALUES (?,?,1,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,active=1,last_seen=excluded.last_seen""",
      (uid, name[:80], t, t))


def station(db, sid):
    return db.execute("SELECT * FROM stations WHERE id=?", (sid,)).fetchone()


def state_set(db, uid, action, station_id="", fuel=""):
    db.execute("""INSERT INTO states(user_id,action,station_id,fuel,updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET action=excluded.action,station_id=excluded.station_id,
        fuel=excluded.fuel,updated_at=excluded.updated_at""",
      (uid, action, station_id, fuel, now()))


def state_get(db, uid):
    row = db.execute("SELECT * FROM states WHERE user_id=?", (uid,)).fetchone()
    return row if row and row['updated_at'] >= now()-900 else None


def state_clear(db, uid):
    db.execute("DELETE FROM states WHERE user_id=?", (uid,))


def enqueue(db, uid, text, buttons=None, callback_id=None, dedupe_key=None):
    import json
    if not isinstance(text,str) or not text or len(text)>3900:
        raise ValueError('Некорректная длина ответа')
    payload = {'text':text}
    if buttons:
        payload['attachments'] = [{'type':'inline_keyboard','payload':{'buttons':buttons}}]
    kind = 'answer' if callback_id else 'message'
    if callback_id:
        payload = {'callback_id': callback_id, 'message':payload}
    db.execute("""INSERT OR IGNORE INTO outbox(user_id,kind,payload,dedupe_key,created_at)
        VALUES(?,?,?,?,?)""", (uid,kind,json.dumps(payload,ensure_ascii=False),dedupe_key,now()))


def remove_user(db, uid):
    # Delete private reports and associated votes. Replies in MAX already delivered cannot be retracted.
    db.execute("DELETE FROM outbox WHERE user_id=?", (uid,))
    db.execute("DELETE FROM reports WHERE author_id=?", (uid,))
    db.execute("DELETE FROM votes WHERE user_id=?", (uid,))
    db.execute("DELETE FROM follows WHERE user_id=?", (uid,))
    db.execute("DELETE FROM states WHERE user_id=?", (uid,))
    db.execute("DELETE FROM users WHERE id=?", (uid,))


def vacuum_expired():
    with transaction() as db:
        t=now()
        db.execute('DELETE FROM processed WHERE created_at < ?', (t-14*86400,))
        db.execute("DELETE FROM outbox WHERE status IN ('sent','dead') AND created_at < ?", (t-7*86400,))
        # No real posts silently deleted; expiry is checked when displaying.
