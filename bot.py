"""MAX-only private dialog bot. All DB changes and replies happen in one transaction."""
import re
from decimal import Decimal, InvalidOperation
from urllib.parse import quote
from . import store

FUEL = {'92':'АИ-92','95':'АИ-95','98':'АИ-98','dt':'ДТ','gas':'Газ'}
DURATION = {'fuel':12*3600, 'price':24*3600, 'queue':3600, 'closed':6*3600}
KIND = {'fuel':'Топливо','price':'Цена','queue':'Очередь','closed':'Работа АЗС'}
PAGE_SIZE = 6


def kb(*rows):
    return [[{'type':'callback', 'text':label[:45], 'payload':payload} for label,payload in row] for row in rows]


def single(*buttons):
    return kb(*[[(label,cmd)] for label,cmd in buttons])


def home():
    return kb([('Найти АЗС','search'),('Все АЗС','list:0')],
              [('Районы','districts'),('Сети','networks')],
              [('Топливо','fuels'),('Свежие сообщения','recent')],
              [('Подписки','follows'),('Профиль','profile')],
              [('Помощь','help')])


def emit(db, uid, text, buttons=None, callback_id=None):
    store.enqueue(db,uid,text,buttons,callback_id)


def normalize(text):
    return re.sub(r'\s+',' ',str(text or '').strip()).casefold()


def shorten(text, count=58):
    return text if len(text)<=count else text[:count-1]+'…'


def choices(db, uid, kind, value=None, page=0, cb=None):
    page = max(0, min(int(page), 100))
    if kind=='district':
        rows=db.execute('SELECT * FROM stations WHERE district=? ORDER BY name,address', (value,)).fetchall()
        title='Район: '+value
        route='district:'+quote(value,safe='')
    elif kind=='network':
        rows=db.execute('SELECT * FROM stations WHERE name=? ORDER BY district,address',(value,)).fetchall()
        title='Сеть: '+value
        route='network:'+quote(value,safe='')
    elif kind=='search':
        # casefold performed in Python for correct Cyrillic case-insensitive search in SQLite.
        rows=[r for r in db.execute('SELECT * FROM stations ORDER BY name,address')
              if normalize(value) in normalize(' '.join((r['name'],r['district'],r['address'])))]
        title='Поиск: '+shorten(value,35)
        route='search:'+quote(value,safe='')
    elif kind=='fuel':
        ids={r[0] for r in db.execute("""SELECT station_id FROM reports
          WHERE kind='fuel' AND fuel=? AND value='есть' AND expires_at>?
          ORDER BY created_at DESC""",(value,store.now()))}
        rows=[r for r in db.execute('SELECT * FROM stations ORDER BY name,address') if r['id'] in ids]
        title='Сообщения о наличии: '+FUEL[value]
        route='filterfuel:'+value
    else:
        rows=db.execute('SELECT * FROM stations ORDER BY name,address').fetchall()
        title='АЗС Оренбурга'
        route='list'
    if not rows:
        return emit(db,uid,'Нет АЗС по запросу. Попробуйте другой фильтр.',single(('Главное меню','home')),cb)
    # page for route might be longer than MAX payload limit for search strings, cap search length.
    page=min(page,(len(rows)-1)//PAGE_SIZE)
    subset=rows[page*PAGE_SIZE:(page+1)*PAGE_SIZE]
    btn=[[(shorten(f"{r['name']} · {r['address']}",45),'s:'+r['id'])] for r in subset]
    nav=[]
    if page:nav.append(('◀ Назад',f'{route}:{page-1}'))
    if (page+1)*PAGE_SIZE<len(rows):nav.append(('Далее ▶',f'{route}:{page+1}'))
    if nav:btn.append([(dict(type='callback',text=x,payload=p)) for x,p in nav])
    btn.append([dict(type='callback',text='Меню',payload='home')])
    emit(db,uid,f'{title}\nВсего: {len(rows)} · страница {page+1}/{(len(rows)-1)//PAGE_SIZE+1}\nВыберите станцию:',btn,cb)


def report_text(r):
    tag = KIND.get(r['kind'],r['kind'])
    if r['fuel']:tag+=' '+FUEL.get(r['fuel'],r['fuel'])
    if r['kind']=='price':value=r['value']+' ₽/л'
    else:value=r['value']
    points=f"  ({r['positive']}✓ / {r['negative']}✕)" if r['positive'] or r['negative'] else ''
    age=max(0,(store.now()-r['created_at'])//60)
    age_txt=f'{age} мин' if age<120 else f'{age//60} ч'
    return f"• {tag}: {value} · {age_txt} назад{points}"


def station_card(db,uid,sid,cb=None):
    s=store.station(db,sid)
    if s is None:
        return emit(db,uid,'АЗС не найдена.',single(('Меню','home')),cb)
    follows=bool(db.execute('SELECT 1 FROM follows WHERE user_id=? AND station_id=?',(uid,sid)).fetchone())
    reports=db.execute('''SELECT r.*, (SELECT COUNT(*) FROM votes v WHERE v.report_id=r.id AND v.value=1) positive,
     (SELECT COUNT(*) FROM votes v WHERE v.report_id=r.id AND v.value=-1) negative
      FROM reports r WHERE r.station_id=? AND r.expires_at>?
      ORDER BY r.created_at DESC, r.id DESC LIMIT 3''',(sid,store.now())).fetchall()
    text=f"{s['name']}\n{s['address']} · {s['district']} район"
    text+='\n\nПоследние сообщения:'+'\n'+'\n'.join(report_text(r) for r in reports) if reports else '\n\nАктуальных сообщений пока нет. Наличие и цены неизвестны.'
    if s['lat'] is not None and s['lon'] is not None:
        text+=f"\n\nНа карте: https://www.openstreetmap.org/?mlat={s['lat']}&mlon={s['lon']}#map=16/{s['lat']}/{s['lon']}"
    else:
        text+='\n\nКоординаты не подтверждены.'
    buttons=kb([('Сообщить об АЗС','p:'+sid),('Отписаться' if follows else 'Подписаться','sub:'+sid)])
    for r in reports[:2]:
        buttons.append([dict(type='callback',text=f"✓ Подтвердить #{r['id']}",payload=f"v:{r['id']}:1"),
                        dict(type='callback',text=f"✕ Опровергнуть #{r['id']}",payload=f"v:{r['id']}:-1")])
    buttons.append([dict(type='callback',text='Меню',payload='home')])
    emit(db,uid,text,buttons,cb)


def publish(db,uid,sid,kind,fuel,value,cb):
    s=store.station(db,sid)
    if not s or kind not in DURATION or fuel not in FUEL and fuel!='':
        return emit(db,uid,'Некорректные данные.',single(('Меню','home')),cb)
    if kind in ('fuel','price') and not fuel:
        return emit(db,uid,'Выберите марку топлива.',single(('К АЗС','s:'+sid)),cb)
    if kind in ('queue','closed') and fuel:
        return emit(db,uid,'Некорректный тип топлива.',single(('К АЗС','s:'+sid)),cb)
    if kind=='fuel' and value not in ('есть','нет'):return
    if kind=='queue' and value not in ('нет','до 5','5–15','15+'):return
    if kind=='closed' and value not in ('закрыта','открыта'):return
    if kind=='price':
        try:
            d=Decimal(value.replace(',','.'))
            if not d.is_finite() or d < 1 or d>1000 or d.as_tuple().exponent < -2:
                raise InvalidOperation()
            value=str(d.quantize(Decimal('0.01')))
        except (InvalidOperation,ValueError):
            return emit(db,uid,'Введите цену числом от 1 до 1000, например 64.50.',single(('Отмена','s:'+sid)),cb)
    t=store.now()
    spam=db.execute('SELECT COUNT(*) FROM reports WHERE author_id=? AND created_at>?',(uid,t-3600)).fetchone()[0]
    day=db.execute('SELECT COUNT(*) FROM reports WHERE author_id=? AND created_at>?',(uid,t-86400)).fetchone()[0]
    if spam>=4 or day>=15:
        return emit(db,uid,'Лимит публикаций: не более 4 в час и 15 за сутки.',single(('К АЗС','s:'+sid)),cb)
    dup=db.execute('''SELECT id FROM reports WHERE author_id=? AND station_id=? AND kind=? AND fuel=? AND value=?
                      AND created_at>?''',(uid,sid,kind,fuel,value,t-3600)).fetchone()
    if dup:
        return emit(db,uid,'Такое сообщение уже опубликовано вами недавно.',single(('К АЗС','s:'+sid)),cb)
    cur=db.execute('''INSERT INTO reports(station_id,author_id,kind,fuel,value,created_at,expires_at)
                      VALUES(?,?,?,?,?,?,?)''',(sid,uid,kind,fuel,value,t,t+DURATION[kind]))
    rid=cur.lastrowid
    store.state_clear(db,uid)
    text=f'Новое сообщение: {s["name"]}, {s["address"]}\n{KIND[kind]}'
    if fuel:text+=' '+FUEL[fuel]
    text+=': '+value+(' ₽/л' if kind=='price' else '')
    text+='\nДанные предоставлены пользователем и не проверены администрацией.'
    subscribers=db.execute('''SELECT u.id FROM follows f JOIN users u ON u.id=f.user_id
       WHERE f.station_id=? AND u.active=1 AND u.id<>?''',(sid,uid)).fetchall()
    for row in subscribers:
        btn=kb([('✓ Подтвердить',f'v:{rid}:1'),('✕ Опровергнуть',f'v:{rid}:-1')],
               [('АЗС',f's:{sid}'),('Отписаться',f'sub:{sid}')])
        store.enqueue(db,row['id'],text,btn,dedupe_key=f'notice:{rid}:{row["id"]}')
    status = 'Сообщение сохранено. Уведомления поставлены в очередь.' if subscribers else 'Сообщение сохранено. Подписчиков у этой АЗС пока нет.'
    emit(db,uid,status,single(('К АЗС','s:'+sid),('Меню','home')),cb)


def vote(db,uid,rid,value,cb):
    r=db.execute('SELECT * FROM reports WHERE id=? AND expires_at>?',(rid,store.now())).fetchone()
    if not r:
        return emit(db,uid,'Сообщение уже неактуально.',single(('Меню','home')),cb)
    if r['author_id']==uid:
        return emit(db,uid,'Нельзя оценивать собственное сообщение.',single(('К АЗС','s:'+r['station_id'])),cb)
    current=db.execute('SELECT value FROM votes WHERE report_id=? AND user_id=?',(rid,uid)).fetchone()
    if current:
        return emit(db,uid,'Вы уже оценили это сообщение.',single(('К АЗС','s:'+r['station_id'])),cb)
    db.execute('INSERT INTO votes(report_id,user_id,value) VALUES(?,?,?)',(rid,uid,value))
    emit(db,uid,'Оценка сохранена.',single(('К АЗС','s:'+r['station_id']),('Меню','home')),cb)


def profile(db,uid,cb=None):
    r=db.execute('''SELECT count(*) reports FROM reports WHERE author_id=?''',(uid,)).fetchone()
    stats=db.execute('''SELECT COALESCE(SUM(v.value),0) score FROM votes v
                       JOIN reports r ON r.id=v.report_id WHERE r.author_id=?''',(uid,)).fetchone()
    followed=db.execute('SELECT COUNT(*) FROM follows WHERE user_id=?',(uid,)).fetchone()[0]
    emit(db,uid,f'Ваш профиль\nПубликаций: {r["reports"]}\nРепутация: {stats["score"]}\nПодписок: {followed}\n\nДля удаления данных нажмите ниже.',
         kb([('Подписки','follows'),('Удалить мои данные','delete:ask')],[('Меню','home')]),cb)


def handle_action(db,uid,action,cb=None):
    from urllib.parse import unquote
    p=action.split(':')
    cmd=p[0]
    if cmd=='home':
        store.state_clear(db,uid)
        return emit(db,uid,'РАДАР БАК · Оренбург\nАктуальность зависит от сообщений автомобилистов. Выберите действие:',home(),cb)
    if cmd=='help':
        return emit(db,uid,'Выберите АЗС через поиск, район или список.\nВ карточке можно сообщить о цене, топливе, очереди или закрытии, подтвердить данные и подписаться.\nПоиск: введите часть адреса или название сети.\nКоманды: /start, /find <слово>, /cancel, /delete.\nБот общается только в личном диалоге.',single(('Меню','home')),cb)
    if cmd=='search':
        store.state_set(db,uid,'search')
        return emit(db,uid,'Введите название, район или часть адреса АЗС:',single(('Отмена','home')),cb)
    if cmd=='list' and len(p)==2 and p[1].isdigit():return choices(db,uid,'all',page=int(p[1]),cb=cb)
    if cmd=='districts':
        names=[r[0] for r in db.execute('SELECT DISTINCT district FROM stations ORDER BY district')]
        return emit(db,uid,'Выберите район:',single(*[(x,'district:'+quote(x,safe='')+':0') for x in names],('Меню','home')),cb)
    if cmd=='fuels':
        return emit(db,uid,'АЗС с актуальными сообщениями о наличии:',
            single(*[(label,'filterfuel:'+key+':0') for key,label in FUEL.items()],('Меню','home')),cb)
    if cmd=='networks':
        names=[r[0] for r in db.execute('SELECT DISTINCT name FROM stations ORDER BY name')]
        return emit(db,uid,'Выберите сеть:',single(*[(x,'network:'+quote(x,safe='')+':0') for x in names],('Меню','home')),cb)
    if cmd in ('district','network','search','filterfuel') and len(p)>=3:
        raw=':'.join(p[1:-1])
        page=int(p[-1]) if p[-1].isdigit() else 0
        value=unquote(raw)
        if cmd=='search' and len(value)>60:return emit(db,uid,'Поиск слишком длинный.',single(('Меню','home')),cb)
        if cmd=='filterfuel':
            if value not in FUEL:return
            return choices(db,uid,'fuel',value,page,cb)
        if cmd in ('district','network') and not db.execute('SELECT 1 FROM stations WHERE '+('district' if cmd=='district' else 'name')+'=?',(value,)).fetchone():return
        return choices(db,uid,cmd,value,page,cb)
    if cmd=='s' and len(p)==2:return station_card(db,uid,p[1],cb)
    if cmd=='sub' and len(p)==2:
        sid=p[1]
        if not store.station(db,sid):return
        existing=db.execute('SELECT 1 FROM follows WHERE user_id=? AND station_id=?',(uid,sid)).fetchone()
        if existing:
            db.execute('DELETE FROM follows WHERE user_id=? AND station_id=?',(uid,sid))
            return station_card(db,uid,sid,cb)
        if db.execute('SELECT COUNT(*) FROM follows WHERE user_id=?',(uid,)).fetchone()[0]>=20:
            return emit(db,uid,'Максимум 20 подписок. Отпишитесь от ненужных АЗС.',single(('Подписки','follows')),cb)
        db.execute('INSERT INTO follows(user_id,station_id) VALUES(?,?)',(uid,sid))
        return station_card(db,uid,sid,cb)
    if cmd=='follows':
        rows=db.execute('SELECT s.* FROM follows f JOIN stations s ON s.id=f.station_id WHERE f.user_id=? ORDER BY s.name,s.address',(uid,)).fetchall()
        return emit(db,uid,'Ваши подписки:' if rows else 'Вы пока не подписаны ни на одну АЗС.',
           single(*[(shorten(x['name']+' · '+x['address'],45),'s:'+x['id']) for x in rows],('Меню','home')),cb)
    if cmd=='recent':
        rows=db.execute('''SELECT r.*, s.name, s.address FROM reports r JOIN stations s ON s.id=r.station_id
             WHERE r.expires_at>? ORDER BY r.created_at DESC, r.id DESC LIMIT 6''',(store.now(),)).fetchall()
        if not rows:return emit(db,uid,'Актуальных сообщений пока нет.',single(('Меню','home')),cb)
        lines=[f"• {x['name']}, {shorten(x['address'],27)}: {KIND[x['kind']]} {FUEL.get(x['fuel'],'')} — {x['value']}" for x in rows]
        return emit(db,uid,'Свежие сообщения:\n'+'\n'.join(lines),single(*[('АЗС '+str(i+1),'s:'+r['station_id']) for i,r in enumerate(rows)],('Меню','home')),cb)
    if cmd=='profile':return profile(db,uid,cb)
    if cmd=='delete' and len(p)==2:
        if p[1]=='ask':
            return emit(db,uid,'Удалить профиль, подписки, публикации и оценки без возможности восстановления?',
                kb([('Да, удалить','delete:confirm'),('Отмена','profile')]),cb)
        if p[1]=='confirm':
            store.remove_user(db,uid)
            return emit(db,uid,'Ваши данные удалены. Чтобы начать заново, отправьте /start.',None,cb)
    if cmd=='p' and len(p)==2 and store.station(db,p[1]):
        sid=p[1]
        return emit(db,uid,'О чём хотите сообщить?',kb([('Наличие топлива',f'kind:{sid}:fuel'),('Цена',f'kind:{sid}:price')],
          [('Очередь',f'kind:{sid}:queue'),('Открыта / закрыта',f'kind:{sid}:closed')],[('Отмена','s:'+sid)]),cb)
    if cmd=='kind' and len(p)==3 and store.station(db,p[1]):
        sid,kind=p[1:]
        if kind in ('fuel','price'):
            return emit(db,uid,'Выберите марку топлива:',single(*[(v,f'fuel:{sid}:{kind}:{k}') for k,v in FUEL.items()],('Назад','p:'+sid)),cb)
        if kind=='queue':
            return emit(db,uid,'Очередь на АЗС:',single(*[(x,f'post:{sid}:queue:_:{x}') for x in ('нет','до 5','5–15','15+')],('Отмена','s:'+sid)),cb)
        if kind=='closed':
            return emit(db,uid,'Работа АЗС:',single(('Закрыта',f'post:{sid}:closed:_:закрыта'),('Открыта',f'post:{sid}:closed:_:открыта'),('Отмена','s:'+sid)),cb)
    if cmd=='fuel' and len(p)==4:
        sid,kind,fuel=p[1:]
        if not store.station(db,sid) or fuel not in FUEL:return
        if kind=='fuel':
            return emit(db,uid,FUEL[fuel]+': наличие?',single(('Есть',f'post:{sid}:fuel:{fuel}:есть'),('Нет',f'post:{sid}:fuel:{fuel}:нет'),('Отмена','s:'+sid)),cb)
        if kind=='price':
            store.state_set(db,uid,'price',sid,fuel)
            return emit(db,uid,f'Введите стоимость {FUEL[fuel]} за литр (например, 64.50):',single(('Отмена','s:'+sid)),cb)
    if cmd=='post' and len(p)==5:
        sid,kind,fuel,val=p[1:]
        return publish(db,uid,sid,kind,'' if fuel=='_' else fuel,val,cb)
    if cmd=='v' and len(p)==3 and p[1].isdigit() and p[2] in ('1','-1'):
        return vote(db,uid,int(p[1]),int(p[2]),cb)
    return emit(db,uid,'Команда устарела или не распознана.',single(('Меню','home')),cb)


def handle_text(db,uid,text):
    text=str(text or '').strip()
    if text.startswith('/start') or text in ('Меню','меню'):
        return handle_action(db,uid,'home')
    if text in ('/cancel','Отмена','отмена'):
        store.state_clear(db,uid)
        return handle_action(db,uid,'home')
    if text=='/delete':return handle_action(db,uid,'delete:ask')
    if text.startswith('/find '):return choices(db,uid,'search',text[6:][:60])
    if text=='/help':return handle_action(db,uid,'help')
    state=store.state_get(db,uid)
    if state and state['action']=='price':
        if len(text)>20:return emit(db,uid,'Введите только цену, например 64.50.',single(('Отмена','s:'+state['station_id'])))
        return publish(db,uid,state['station_id'],'price',state['fuel'],text,None)
    if state and state['action']=='search':
        store.state_clear(db,uid)
        if len(text)>60:return emit(db,uid,'Введите запрос короче 60 символов.',single(('Поиск','search')))
        return choices(db,uid,'search',text)
    if text and not text.startswith('/') and len(text)<=60:
        return choices(db,uid,'search',text)
    return emit(db,uid,'Нажмите «Меню» или отправьте /start.',home())


def handle_update(db, event):
    typ=event.get('update_type')
    if typ not in ('message_created','message_callback','bot_started','bot_stopped','dialog_removed'):
        return
    msg=event.get('message') or {}
    recipient=msg.get('recipient') or {}
    if typ in ('message_created','message_callback') and recipient.get('chat_type')!='dialog':
        return # Private-only. No responses and no publications from groups or channels.
    if typ=='message_created':
        user=msg.get('sender') or {}; mid=(msg.get('body') or {}).get('mid')
        if not mid or user.get('is_bot'):return
        key='msg:'+str(mid)
    elif typ=='message_callback':
        callback=event.get('callback') or {}; user=callback.get('user') or {}
        cid=callback.get('callback_id')
        if not cid:return
        key='cb:'+str(cid)
    else:
        user=event.get('user') or {}; key=typ+':'+str(user.get('user_id',''))+':'+str(event.get('timestamp',''))
    uid=str(user.get('user_id',''))
    if not uid.isdigit() or len(uid)>20:return
    # This insert is unique across webhook retries, and is committed in the same transaction
    # as the user's action and outbound responses.
    c=db.execute('INSERT OR IGNORE INTO processed(event_key,created_at) VALUES(?,?)',(key,store.now()))
    if c.rowcount==0:return
    if typ in ('bot_stopped','dialog_removed'):
        db.execute('UPDATE users SET active=0 WHERE id=?',(uid,))
        store.state_clear(db,uid)
        db.execute("DELETE FROM outbox WHERE user_id=? AND status IN ('pending','sending')",(uid,))
        return
    name=str(user.get('name') or user.get('first_name') or '')[:80]
    store.user_upsert(db,uid,name)
    if typ=='bot_started':return handle_action(db,uid,'home')
    if typ=='message_callback':
        action=str(callback.get('payload') or '')
        if len(action)>300:return
        return handle_action(db,uid,action,cid)
    body=msg.get('body') or {}
    text=body.get('text')
    if not text:return emit(db,uid,'Используйте кнопки или текст для поиска.',home())
    return handle_text(db,uid,text)
