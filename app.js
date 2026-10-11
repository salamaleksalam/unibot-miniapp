'use strict';
(() => {
const raw = Array.isArray(window.TOPLIVO56_STATIONS) ? window.TOPLIVO56_STATIONS : [];
const majorBrands = ['Лукойл','Башнефть','Газпром','Газпромнефть','Татнефть'];
const districts = ['Дзержинский','Промышленный','Центральный','Ленинский'];
const fuels = ['АИ-92','АИ-95','АИ-98','АИ-100','ДТ'];
const brandKeys = [...majorBrands,'Другие сети'];
const EVENTS = {availability:'Наличие топлива',closure:'Работа АЗС',price:'Цены',queue:'Очереди'};
const scopes = {favorites:'Избранные АЗС',districts:'Выбранные районы',brands:'Выбранные сети',city:'Весь Оренбург'};
const FREQ = {balanced:'Обычный',digest:'Сводка не чаще 2 часов',minimal:'Только закрытия'};
const canon = name => name.startsWith('Газпром АЗС') ? 'Газпром' : name;
const stations = raw.filter(s=>!/(?:^|\s)(?:АГЗС|АГНКС)(?:\s|$)/i.test(s.name)).map(s=>({...s,brand:canon(s.name),local:!majorBrands.includes(canon(s.name))}));
const byId = new Map(stations.map(s=>[s.id,s]));
const KEY='radarbak_user_v2';
const defaults = {favorites:[],prefs:{scopes:['favorites'],districts:[],brands:[],events:['availability','closure','price'],fuel:'АИ-95',frequency:'balanced',quiet:true,weekly:true}};
const clone = x => JSON.parse(JSON.stringify(x));
let state = clone(defaults);
try { const prev = JSON.parse(localStorage.getItem(KEY)||'null'); if(prev&&typeof prev==='object') {
  state.favorites = Array.isArray(prev.favorites)?prev.favorites.filter(id=>byId.has(id)):[];
  state.prefs = {...defaults.prefs,...prev.prefs};if(!Array.isArray(state.prefs.scopes))state.prefs.scopes=[state.prefs.scope||'favorites'];
}} catch(e){}
function save(){try{localStorage.setItem(KEY,JSON.stringify(state));return true}catch(e){toast('Не удалось сохранить: хранилище браузера недоступно');return false}}
const $ = id=>document.getElementById(id);
const esc = str => String(str===null||str===undefined?'':str).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const el=(tag,cls,html)=>{let x=document.createElement(tag);if(cls)x.className=cls;if(html!==undefined)x.innerHTML=html;return x};
let map = null,markers=[], selectedDistrict='Все',selectedBrand='Все',search='',currentTab='map',hideTimeout;
let activeStation=null, reportFuel=state.prefs.fuel, multiAvailability={};
let feed=[], community=[], serverWritesEnabled=false, isFeedLoading=false, feedTimer=null, writeBusy=false; const markerByStation=new Map();
function toast(msg){const x=$('toast');x.textContent=msg;x.classList.add('show');clearTimeout(hideTimeout);hideTimeout=setTimeout(()=>x.classList.remove('show'),3500)}
function localBadge(s){return s.local?'<span class="local-badge" title="Сеть не входит в основной список">◆ Другая сеть</span>':''}
function switchTab(tab){currentTab=tab;document.querySelectorAll('.section').forEach(x=>x.classList.toggle('active',x.id==='tab-'+tab));document.querySelectorAll('.nav-button').forEach(x=>{let is=x.dataset.tab===tab;x.classList.toggle('active',is);x.setAttribute('aria-current',is?'page':'false')});$('scroll-area').scrollTo({top:0});if(tab==='map') {setTimeout(()=>{ensureMap();map&&map.invalidateSize(true)},80)}if(tab==='list')renderList();if(tab==='subscriptions')renderSubscriptions();if(tab==='profile')renderProfile()}
function filtered(){return stations.filter(s=>(selectedDistrict==='Все'||s.district===selectedDistrict)&&(selectedBrand==='Все'||(selectedBrand==='Другие сети'?s.local:s.brand===selectedBrand))&&(`${s.name} ${s.address} ${s.district}`.toLowerCase().includes(search.toLowerCase())))}
function makeChip(container,text,active,onClick){const b=el('button','chip'+(active?' active':''),esc(text));b.type='button';b.addEventListener('click',onClick);container.appendChild(b)}
function setupFilters(){const d=$('district-filters');d.innerHTML='';['Все',...districts].forEach(n=>makeChip(d,n,selectedDistrict===n,()=>{selectedDistrict=n;setupFilters();renderList()}));const b=$('brand-filters');b.innerHTML='';['Все',...brandKeys].forEach(n=>makeChip(b,n,selectedBrand===n,()=>{selectedBrand=n;setupFilters();renderList()}));$('fuel-filters').innerHTML='';fuels.forEach(n=>makeChip($('fuel-filters'),n,state.prefs.fuel===n,()=>{state.prefs.fuel=n;reportFuel=n;save();setupFilters();renderList();updateMapMarkers();toast('Топливо для быстрых сообщений: '+n)}))}

function confirmedCommunity(){return community.filter(x=>x.review==='подтверждено участниками');}
function eventsForStation(id){return [...feed,...confirmedCommunity().filter(x=>x.stationId===id).map(x=>({...x,community:true}))].sort((a,b)=>b.ts.localeCompare(a.ts)) .filter(x=>x.stationId===id)}
function latestEvent(id,type,fuel=''){
 return eventsForStation(id).find(x=>x.type===type && (fuel ? x.fuel===fuel : true)) || null;
}
function ageText(ts){const m=Math.max(0,Math.floor((Date.now()-Date.parse(ts))/60000));return m<1?'только что':m<60?m+' мин. назад':Math.floor(m/60)+' ч. назад'}
function fuelChip(s,f){const r=latestEvent(s.id,'availability',f);if(!r)return `<span>${esc(f)} · ?</span>`;const yes=r.value==='есть';return `<span class="${yes?'known-yes':'known-no'} " title="${esc(ageText(r.ts))}">${esc(f)} · ${yes?'есть':'нет'}${r.community?' · по отзывам':''}</span>`}
function stationMeta(s){const closed=latestEvent(s.id,'closure');if(closed){const open=closed.value==='открыта снова';return `${open?'🟢':'🟠'} По опубликованной записи: ${esc(closed.value)} · ${ageText(closed.ts)}`}; const some=eventsForStation(s.id);return some.length?`● Есть записи из базы · ${ageText(some[0].ts)}`:'● Актуальных сведений нет'}
function liveLine(x){const labels={availability:`${x.fuel}: ${x.value}`,price:`${x.fuel}: ${x.value} ₽/л`,closure:`Работа АЗС: ${x.value}`,queue:`Очередь: ${x.value}`};return `<div class="live-line normal"><strong>${esc(labels[x.type]||x.value)}</strong><small>${x.community?'Сообщение подтверждено участниками':'Запись из базы'} · ${esc(ageText(x.ts))}. Не гарантирует текущую ситуацию.</small></div>`}
function cardCommunity(x,compact=false){
 const s=byId.get(x.stationId);if(!s)return '';
 const status=x.review==='подтверждено участниками'?'review-confirmed':x.review==='спорное'?'review-disputed':'';
 const valueText=({availability:`${x.fuel}: ${x.value}`,queue:`Очередь: ${x.value}`,price:`${x.fuel}: ${x.value} ₽/л`,closure:`Работа АЗС: ${x.value}`})[x.type]||x.value;
 const confirmers=Array.isArray(x.confirmers)?x.confirmers:[];
 const people=confirmers.length?`<details class="confirmers"><summary>Кто подтвердил (${confirmers.length})</summary><div>${confirmers.map(n=>`<span class="confirm-name">✓ ${esc(n)}</span>`).join('')}</div></details>`:'';
 return `<div class="community-card"><h3>${esc(s.name)} · ${esc(s.address)}</h3><div class="community-sub">${esc(s.district)} район · ${esc(ageText(x.ts))} · сообщил: <b>${esc(x.author||'Участник MAX')}</b></div><b>${esc(valueText)}</b><br><span class="community-status ${status}">${esc(x.review)}</span><div class="community-sub">Подтверждений: ${Number(x.agree)||0} · Возражений: ${Number(x.disagree)||0}</div>${people}<div class="community-actions"><button type="button" data-vote="agree" data-report-id="${esc(x.id)}">✓ Подтвердить</button><button type="button" data-vote="disagree" data-report-id="${esc(x.id)}">✕ Не совпадает</button></div><p class="community-note">Мнения водителей могут быть неточными или устареть. По кнопке ваше имя MAX будет видно в списке участников (после согласия). ${liveWritesEnabled()?'':'Отправка сейчас недоступна.'}</p></div>`;
}
function renderCommunity(){const target=$('community-list');if(!target)return;target.innerHTML=community.length?community.slice(0,15).map(x=>cardCommunity(x,true)).join(''):'<div class="empty">Общих сообщений пока нет. На карте можно посмотреть АЗС, а сведения появятся после публикаций участников.</div>'}
function getMaxInitData(){
 const v=window.WebApp&&typeof window.WebApp.initData==='string'?window.WebApp.initData:'';
 if(v)return v;
 try{return new URLSearchParams(location.hash.slice(1)).get('WebAppData')||''}catch(e){return ''}
}
function liveWritesEnabled(){return serverWritesEnabled && window.TOPLIVO56_CONFIG?.COMMUNITY_WRITES_ENABLED===true}
function randomRequestId(){const a=new Uint8Array(18);crypto.getRandomValues(a);return 'req_'+Array.from(a,b=>('0'+b.toString(16)).slice(-2)).join('')}
function readJsonp(action, params={}){
 return new Promise((resolve,reject)=>{
  const api=String(window.TOPLIVO56_CONFIG?.API_URL||'');
  const fn='toplivo56_cb_'+Date.now()+'_'+Math.floor(Math.random()*9999999);
  const url=api+'?'+new URLSearchParams({action,callback:fn,...params});
  const script=document.createElement('script');let ended=false;
  function clean(){if(ended)return;ended=true;clearTimeout(timer);delete window[fn];script.remove()}
  window[fn]=d=>{clean();resolve(d)};
  script.onerror=()=>{clean();reject(Error('Ошибка связи с базой'))};
  const timer=setTimeout(()=>{clean();reject(Error('Превышено время ожидания ответа'))},20000);
  script.src=url;document.head.appendChild(script);
 });
}
function sendCommunity(action,params){
 return new Promise((resolve,reject)=>{
   const api=String(window.TOPLIVO56_CONFIG?.API_URL||'');
   const data=getMaxInitData();
   if(!liveWritesEnabled())return reject(new Error('Публикация временно недоступна'));
   if(!data)return reject(new Error('Для публикации открой приложение внутри MAX'));
   if(writeBusy)return reject(new Error('Сначала дождись завершения предыдущей операции'));
   writeBusy=true;
   const req=randomRequestId(),iframe=document.createElement('iframe'),form=document.createElement('form');
   iframe.name='post_'+req;iframe.style.display='none';iframe.setAttribute('aria-hidden','true');
   form.action=api;form.method='POST';form.target=iframe.name;form.style.display='none';
   const all={...params,action,webAppData:data,requestId:req};
   Object.entries(all).forEach(([k,v])=>{const x=document.createElement('input');x.type='hidden';x.name=k;x.value=String(v);form.appendChild(x)});
   let settled=false,cleanupTimer,receiptTimer;
   const finish=(err,result)=>{if(settled)return;settled=true;clearTimeout(cleanupTimer);clearTimeout(receiptTimer);window.removeEventListener('message',receive);iframe.remove();form.remove();writeBusy=false;err?reject(err):resolve(result)};
   const receive=e=>{
     if(!['https://script.google.com','https://script.googleusercontent.com','null'].includes(e.origin))return;
     const result=e.data;
     if(!result||result.channel!=='toplivo56-write'||result.requestId!==req)return;
     result.ok?finish(null,result):finish(Error(result.error||'Сервер отклонил запрос'));
   };
   window.addEventListener('message',receive);document.body.appendChild(iframe);document.body.appendChild(form);
   // Поддержка браузеров MAX, блокирующих ответы Google из вложенных iframe:
   // подтверждаем результат по одноразовому номеру запроса (идемпотентно).
   const began=Date.now();
   async function checkReceipt(){
     if(settled)return;
     try{const d=await readJsonp('receipt',{requestId:req});
       if(d&&d.pending!==true){d.ok?finish(null,d):finish(Error(d.error||'Сервер отклонил запрос'));return;}
     }catch(e){}
     if(!settled&&Date.now()-began<55000)receiptTimer=setTimeout(checkReceipt,4500);
   }
   cleanupTimer=setTimeout(()=>finish(Error('Подтверждение не получено. Не повторяй операцию сразу: проверь общую ленту и перезапусти приложение.')),60000);
   try{form.submit();receiptTimer=setTimeout(checkReceipt,5000)}catch(e){finish(e)}
 });
}
async function voteCommunity(id,decision){
 if(!liveWritesEnabled()){toast('Подтверждение временно недоступно');return}
 try{
   if(!window.confirm('Отправить подтверждение? Другие участники увидят твоё имя из MAX. Подтверждай только лично проверенные сведения.'))return;
   await sendCommunity('vote',{reportId:id,decision,publicNameConsent:'YES'});toast('Оценка отправлена. Спасибо!');setTimeout(loadPublicFeed,1400)
 }
 catch(e){toast(e.message)}
}
function renderFeedUI(){renderList();renderFavorites();renderCommunity();updateMapMarkers();if(activeStation&&$('sheet')&&!$('sheet').hidden&&$('sheet').dataset.view==='detail')showDetail(activeStation)}
function setFeedStatus(message){const el=$('api-connection');if(el)el.textContent=message}
function loadPublicFeed(){
 const url=String(window.TOPLIVO56_CONFIG?.API_URL||'').trim();
 if(!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url)){
   serverWritesEnabled=false;setFeedStatus('○ Сведения участников сейчас недоступны');return;
 }
 if(isFeedLoading)return;
 isFeedLoading=true;setFeedStatus('◌ Загружаем опубликованные сведения…');
 const name='toplivo56_cb_'+Date.now()+'_'+Math.floor(Math.random()*1e7);
 const scr=document.createElement('script');let done=false;
 const stop=(msg)=>{if(done)return;done=true;clearTimeout(timeout);delete window[name];scr.remove();isFeedLoading=false;if(msg)setFeedStatus(msg)};
 const timeout=setTimeout(()=>{serverWritesEnabled=false;stop('⚠ Нет связи с сервером. Публикация недоступна.')},25000);
 window[name]=data=>{
   if(!data||data.ok!==true||!Array.isArray(data.items)){
     serverWritesEnabled=false;stop('⚠ Сведения временно недоступны');return;
   }
   feed=data.items.filter(x=>x&&byId.has(x.stationId)&&['availability','price','queue','closure'].includes(x.type)
       &&typeof x.ts==='string'&&Number.isFinite(Date.parse(x.ts)))
       .sort((a,b)=>b.ts.localeCompare(a.ts)).slice(0,300);
   community=(Array.isArray(data.community)?data.community:[]).filter(x=>x&&byId.has(x.stationId)&&/^p-[0-9a-f-]{36}$/i.test(x.id)&&Number.isFinite(Date.parse(x.ts))).slice(0,100);
   renderFeedUI();
     serverWritesEnabled = data.build === '2.0' && data.writesEnabled === true;
   stop(serverWritesEnabled?'● Сервис работает · сообщений: '+community.length:'● Справочник доступен · публикация временно недоступна');
 };
 scr.onerror=()=>{serverWritesEnabled=false;stop('⚠ Нет соединения с сервером')};
 scr.src=url+'?action=feed&callback='+encodeURIComponent(name)+'&ts='+Date.now();
 document.head.appendChild(scr);
}
function markerColor(s){const cl=latestEvent(s.id,'closure');if(cl&&cl.value!=='открыта снова')return '#e1a35f'; const a=latestEvent(s.id,'availability',state.prefs.fuel);return a?(a.value==='есть'?'#5bd29f':'#ee8279'):'#8e9fa3'}
function updateMapMarkers(){for(const [id,m] of markerByStation){const s=byId.get(id);if(!s)continue;const color=markerColor(s);m.setStyle({color,fillColor:color});}}
function stationCard(s){const fav=state.favorites.includes(s.id);let wrap=el('div','station-card',`<div class="station-main"><span class="station-icon">⛽</span><div class="station-title"><b>${esc(s.name)}</b><small>${esc(s.address)} · ${esc(s.district)} район</small></div><button class="favorite-btn ${fav?'is-fav':''}" data-fav="${s.id}" type="button" aria-label="${fav?'Удалить из избранного':'Добавить в избранное'}">${fav?'★':'☆'}</button></div>${localBadge(s)}<div class="station-meta"><span>${stationMeta(s)}</span>${Number.isFinite(s.lat)&&Number.isFinite(s.lon)?'<span>◉ На карте</span>':'<span>Адрес в справочнике</span>'}</div><div class="status-strip">${["АИ-92","АИ-95","ДТ"].map(f=>fuelChip(s,f)).join("")}</div><div class="card-actions"><button class="report" data-report="${s.id}" type="button">＋ Сообщить</button><button class="detail" data-detail="${s.id}" type="button">Карточка АЗС</button></div>`);return wrap}
function renderList(){const arr=filtered();$('list-count').textContent=arr.length;$('results-note').textContent=`Найдено ${arr.length} записей. Фильтр топлива задаёт марку для быстрого сообщения, а не подтверждает её наличие.`;const out=$('list-stations');out.innerHTML='';if(!arr.length){out.innerHTML='<div class="empty">Ничего не найдено. Попробуй выбрать другой район или сеть.</div>';return}
 districts.forEach((district,i)=>{const ss=arr.filter(s=>s.district===district);if(!ss.length)return;const box=el('details','district-group');box.open=(selectedDistrict!=='Все'||search.length>0||selectedBrand!=='Все'||i===0);box.innerHTML=`<summary><span>📍 ${district} район</span><b>${ss.length} АЗС <span aria-hidden="true">⌄</span></b></summary>`;const list=el('div','station-list');ss.forEach(s=>list.appendChild(stationCard(s)));box.appendChild(list);out.appendChild(box)})}
function toggleFav(id){if(!byId.has(id))return;let i=state.favorites.indexOf(id);if(i<0)state.favorites.push(id);else state.favorites.splice(i,1);save();renderList();renderFavorites();renderSubscriptions();if(activeStation===id)showDetail(id);toast(i<0?'АЗС добавлена в избранное':'АЗС удалена из избранного')}
function renderFavorites(){const f=state.favorites.map(id=>byId.get(id)).filter(Boolean);$('map-favorites').innerHTML='';if(f.length){f.slice(0,5).forEach(s=>$('map-favorites').appendChild(stationCard(s)))}else {$('map-favorites').innerHTML='<div class="empty">Пока нет избранных АЗС. Открой раздел «АЗС» и нажми ☆ возле нужного адреса.</div>'}}
function ensureMap(){if(map)return; if(!window.L){$('map-error').hidden=false;return;} try{map=L.map('map',{zoomControl:true,attributionControl:true,scrollWheelZoom:false}).setView([51.772,55.12],10);L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'© OpenStreetMap contributors',maxZoom:19}).on('tileerror',()=>{}).addTo(map);const coords=[];stations.forEach(s=>{if(!Number.isFinite(s.lat)||!Number.isFinite(s.lon))return;coords.push([s.lat,s.lon]);const m=L.circleMarker([s.lat,s.lon],{radius:7,color:s.local?'#fdb870':'#d8f15b',fillColor:s.local?'#fdb870':'#d8f15b',fillOpacity:.95,weight:2}).on('click',()=>showDetail(s.id)).addTo(map);markers.push(m);markerByStation.set(s.id,m)});updateMapMarkers();$('summary-onmap').textContent=coords.length;if(coords.length)map.fitBounds(coords,{padding:[18,18],maxZoom:11});setTimeout(()=>map.invalidateSize(true),300)}catch(e){$('map-error').hidden=false}}
function sheetOpen(title,html){$('sheet').dataset.view='';$('sheet-title').textContent=title;$('sheet-content').innerHTML=html;$('sheet-backdrop').hidden=false;$('sheet').hidden=false;document.body.classList.add('modal-open')}
function closeSheet(){$('sheet').hidden=true;$('sheet-backdrop').hidden=true;document.body.classList.remove('modal-open');activeStation=null}
function showDetail(id){
 const s=byId.get(id);if(!s)return;activeStation=id;
 const fav=state.favorites.includes(id);const records=eventsForStation(id).slice(0,12);
 const hasCoords=Number.isFinite(s.lat)&&Number.isFinite(s.lon);
 const navLink=hasCoords?'https://www.openstreetmap.org/directions?engine=fossgis_osrm_car&route=%3B'+encodeURIComponent(s.lat+','+s.lon):'https://www.openstreetmap.org/search?query='+encodeURIComponent(s.name+', '+s.address+', Оренбург');
 const details=records.length?records.map(liveLine).join(''):'<div class="sheet-alert">Нет свежих опубликованных сведений. Цены, наличие и время работы неизвестны.</div>';
 const html=`<p class="sheet-sub">${esc(s.address)} · ${esc(s.district)} район</p>${localBadge(s)}<div class="detail-meta"><b>Статус АЗС</b><span>${stationMeta(s)}</span></div><div class="detail-meta"><b>Последние опубликованные сведения</b></div>${details}${community.filter(x=>x.stationId===id).slice(0,6).map(x=>cardCommunity(x)).join('')}<div class="detail-actions"><button class="main-btn" data-report="${id}" type="button">＋ Сообщить об изменении</button><button class="outline-btn" data-fav="${id}" type="button">${fav?'★ Убрать из избранного':'☆ В избранное'}</button></div><a class="outline-btn station-directions" target="_blank" rel="noopener noreferrer" href="${esc(navLink)}">${hasCoords?'Построить маршрут ↗':'Найти адрес на карте ↗'}</a>`;
 sheetOpen(s.name,html);$('sheet').dataset.view='detail';
}
function chooser(){activeStation=null;const fav=state.favorites.map(id=>byId.get(id)).filter(Boolean);const ordered=[...fav,...stations.filter(s=>!state.favorites.includes(s.id))];sheetOpen('Выбери АЗС',`<p class="sheet-sub">Начни с избранных или найди заправку по адресу.</p><input id="chooser-search" class="sheet-search" placeholder="Название или улица…" type="search"><div class="station-chooser" id="chooser-stations"></div>`);renderChooser(ordered);$('chooser-search').addEventListener('input',e=>{const v=e.target.value.toLowerCase();renderChooser(ordered.filter(s=>`${s.name} ${s.address} ${s.district}`.toLowerCase().includes(v)))})}
function renderChooser(rows){const list=$('chooser-stations');if(!list)return;list.innerHTML='';rows.slice(0,75).forEach(s=>{const b=el('button','',`<span>⛽</span><span><b>${esc(s.name)}</b><small>${esc(s.address)} · ${esc(s.district)} район ${state.favorites.includes(s.id)?'★':''}</small></span>`);b.addEventListener('click',()=>chooseType(s.id));list.appendChild(b)});if(!rows.length)list.textContent='Не найдено'}
function chooseType(id){const s=byId.get(id);if(!s)return;activeStation=id;sheetOpen('Сообщить: '+s.name,`<p class="sheet-sub">${esc(s.address)}</p><p class="sheet-caption">Что хочешь сообщить?</p><div class="report-types"><button data-type="availability">⛽ Наличие топлива</button><button data-type="price">₽ Цена топлива</button><button data-type="queue">🚗 Очередь</button><button data-type="closure">🔒 АЗС закрыта / открылась</button></div><p class="helper">Укажи только то, что видел лично. Можно выбрать несколько видов топлива.</p>`)}
function availabilityForm(){
 multiAvailability={};
 return `<p class="sheet-caption">Отметь все марки, которые проверил</p><p class="helper">Для каждой марки нажми «Есть» или «Нет». Можно указать разные статусы сразу для нескольких марок. Неизвестные просто пропусти.</p><div class="multi-fuel-list">${fuels.map(f=>`<div class="multi-fuel-row"><b>${esc(f)}</b><div class="multi-actions"><button type="button" data-availability-fuel="${esc(f)}" data-availability-value="есть" aria-pressed="false">✓ Есть</button><button type="button" data-availability-fuel="${esc(f)}" data-availability-value="нет" aria-pressed="false">✕ Нет</button></div></div>`).join('')}</div><button id="save-multi-availability" class="main-btn" type="button">Сохранить выбранные сведения</button>`;
}
function priceForm(){
 return `<p class="sheet-caption">Укажи цены на несколько видов топлива</p><p class="helper">Заполни только те поля, где видел цену. Остальные оставь пустыми.</p><div class="multi-fuel-list">${fuels.map(f=>`<label class="multi-price-row"><b>${esc(f)}</b><input type="text" inputmode="decimal" autocomplete="off" data-price-fuel="${esc(f)}" placeholder="₽ / л"></label>`).join('')}</div><button id="save-multi-prices" type="button" class="main-btn">Сохранить указанные цены</button>`;
}
function chooseReportType(type){if(!byId.has(activeStation))return;const s=byId.get(activeStation);let html=`<p class="sheet-sub">${esc(s.name)} · ${esc(s.address)}</p>`;
 if(type==='availability')html+=availabilityForm();
 if(type==='closure')html+=`<p class="sheet-caption">Работает ли АЗС?</p><div class="outcome-options"><button data-save-type="closure" data-value="закрыта временно">🔴 Временно закрыта</button><button data-save-type="closure" data-value="открыта снова">🟢 Открыта снова</button><button data-save-type="closure" data-value="технический перерыв">🛠 Техперерыв</button><button data-save-type="closure" data-value="причина неизвестна">❔ Закрыта — причина неизвестна</button></div><p class="helper">Причину не нужно придумывать. Если неизвестна — выбирай соответствующий вариант.</p>`;
 if(type==='queue')html+=`<p class="sheet-caption">Примерное время ожидания</p><div class="outcome-options"><button data-save-type="queue" data-value="нет очереди">🟢 Нет очереди</button><button data-save-type="queue" data-value="до 5 минут">До 5 минут</button><button data-save-type="queue" data-value="5–15 минут">5–15 минут</button><button data-save-type="queue" data-value="более 15 минут">Более 15 минут</button></div>`;
 if(type==='price')html+=priceForm();
 sheetOpen(({availability:'Наличие топлива',closure:'Работа АЗС',queue:'Очередь',price:'Цены на топливо'})[type],html);
 $('sheet').dataset.reportType=type;
}
async function saveMultiItems(items){
 if(!activeStation||!byId.has(activeStation))return;
 if(!items.length){toast('Отметь хотя бы одну марку топлива');return;}
 const stationId=activeStation;
 if(!liveWritesEnabled()){toast('Публикация временно недоступна. Попробуй позже.');return;}
 const publicName=maxUserForDisplay();if(!publicName){toast('Не получены данные профиля MAX');return;}
 if(!window.confirm('Опубликовать '+items.length+' отметок для всех водителей Оренбурга? В сообщениях будет видно твоё имя из MAX. Подтверди, что сведения наблюдались лично.'))return;
 try{
   const result=await sendCommunity('report_batch',{stationId,items:JSON.stringify(items),publicNameConsent:'YES'});
   closeSheet();toast('Отправлено: '+result.added+' отметок. Ожидают подтверждений.');setTimeout(loadPublicFeed,1800);
 }catch(e){toast('Не отправлено: '+e.message)}
}
function saveMultiAvailability(){
 const rows=fuels.filter(f=>['есть','нет'].includes(multiAvailability[f])).map(f=>({type:'availability',fuel:f,value:multiAvailability[f]}));
 saveMultiItems(rows);
}
function saveMultiPrices(){
 const inp=Array.from($('sheet-content').querySelectorAll('[data-price-fuel]'));
 const rows=[];
 for(const x of inp){const raw=x.value.trim();if(!raw)continue;const cleaned=raw.replace(',','.');if(!/^\d{1,3}(?:\.\d{1,2})?$/.test(cleaned)){toast('Исправь цену для '+x.dataset.priceFuel);x.focus();return;}const n=Number(cleaned);if(n<1||n>400){toast('Цена для '+x.dataset.priceFuel+' вне допустимого диапазона');x.focus();return;}rows.push({type:'price',fuel:x.dataset.priceFuel,value:n.toFixed(2).replace('.',',')});}
 saveMultiItems(rows);
}
async function saveReport(type,value){
 if(!activeStation||!byId.has(activeStation))return;
 const x={type,value,fuel:type==='availability'||type==='price'?reportFuel:''};
 await saveMultiItems([x]);
}
function renderSubscriptions(){const p=state.prefs;const scope=$('scope-choices');scope.innerHTML='';Object.entries(scopes).forEach(([key,label])=>{const b=el('button','option'+(p.scopes.includes(key)?' active':''),esc(label));b.setAttribute('aria-pressed',p.scopes.includes(key)?'true':'false');b.addEventListener('click',()=>{if(p.scopes.includes(key))p.scopes=p.scopes.filter(x=>x!==key);else p.scopes.push(key);save();renderSubscriptions()});scope.appendChild(b)});
$('scope-helper').textContent='Можно выбрать несколько вариантов одновременно. Уведомления об одном событии не будут дублироваться. Для подписки на весь город включается группировка сообщений.';
 $('subscribe-district-section').hidden=!p.scopes.includes('districts');$('subscribe-brand-section').hidden=!p.scopes.includes('brands');$('subscribe-favs-section').hidden=!p.scopes.includes('favorites');
 function fillCheck(id,vals,field){const x=$(id);x.innerHTML='';vals.forEach(v=>{const label=el('label','check-row',`<input type="checkbox" ${p[field].includes(v)?'checked':''}><span>${esc(v)}</span>`);label.querySelector('input').addEventListener('change',e=>{if(e.target.checked&&!p[field].includes(v))p[field].push(v);if(!e.target.checked)p[field]=p[field].filter(k=>k!==v);save()});x.appendChild(label)})}
 fillCheck('sub-districts',districts,'districts');fillCheck('sub-brands',brandKeys,'brands');
 $('sub-favorites').innerHTML=state.favorites.length?state.favorites.map(id=>byId.get(id)).filter(Boolean).map(s=>`<div class="sub-fav">★ ${esc(s.name)} — ${esc(s.address)}</div>`).join(''):'<div class="empty">Пока ничего не добавлено в избранное.</div>';
 const ev=$('sub-events');ev.innerHTML='';Object.entries(EVENTS).forEach(([key,label])=>{const lab=el('label','check-row',`<input type="checkbox" ${p.events.includes(key)?'checked':''}><span>${esc(label)}</span>`);lab.querySelector('input').addEventListener('change',e=>{if(e.target.checked&&!p.events.includes(key))p.events.push(key);if(!e.target.checked)p.events=p.events.filter(k=>k!==key);save()});ev.appendChild(lab)});
 $('my-fuel-choices').innerHTML='';fuels.forEach(f=>makeChip($('my-fuel-choices'),f,p.fuel===f,()=>{p.fuel=f;reportFuel=f;save();renderSubscriptions();setupFilters()}));
 const freq=$('frequency-choices');freq.innerHTML='';Object.entries(FREQ).forEach(([key,label])=>{const b=el('button','option'+(key===p.frequency?' active':''),esc(label));b.addEventListener('click',()=>{p.frequency=key;save();renderSubscriptions()});freq.appendChild(b)});
 $('quiet-hours').checked=Boolean(p.quiet);$('weekly-digest').checked=Boolean(p.weekly);
}
function maxUserForDisplay(){
 let user=window.WebApp?.initDataUnsafe?.user;
 if(user&&typeof user==='object')return user;
 try{const data=window.WebApp?.initData||new URLSearchParams(location.hash.slice(1)).get('WebAppData')||'';
   const v=new URLSearchParams(data).get('user');return v?JSON.parse(v):null;
 }catch(e){return null;}
}
function renderMaxName(){
 const u=maxUserForDisplay();
 const first=typeof u?.first_name==='string'?u.first_name.trim():'';
 const last=typeof u?.last_name==='string'?u.last_name.trim():'';
 const handle=typeof u?.username==='string'?u.username.trim().replace(/^@/,''):'';
 const full=[first,last].filter(Boolean).join(' ').slice(0,90);
 const name=full||(handle?'@'+handle:'Пользователь MAX');
 $('profile-name').textContent=name;
 $('avatar').textContent=(full||handle||'М').slice(0,1).toUpperCase();
 $('profile-source').textContent=u?'Имя из MAX · изменить можно только в профиле MAX':'Данные MAX ещё не получены · открой приложение внутри MAX';
}
function renderProfile(){ renderMaxName(); }
// Delegate dynamic card and sheet actions.
document.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;if(b.hasAttribute('data-vote')){voteCommunity(b.dataset.reportId,b.dataset.vote);return}if(b.hasAttribute('data-fav')){toggleFav(b.dataset.fav);return}if(b.hasAttribute('data-detail')){showDetail(b.dataset.detail);return}if(b.hasAttribute('data-report')){chooseType(b.dataset.report);return}if(b.hasAttribute('data-type')){chooseReportType(b.dataset.type);return}if(b.hasAttribute('data-availability-fuel')){const f=b.dataset.availabilityFuel,v=b.dataset.availabilityValue;if(!fuels.includes(f)||!['есть','нет'].includes(v))return;multiAvailability[f]=multiAvailability[f]===v?null:v;document.querySelectorAll('[data-availability-fuel]').forEach(btn=>{if(btn.dataset.availabilityFuel===f){const active=multiAvailability[f]===btn.dataset.availabilityValue;btn.setAttribute('aria-pressed',active?'true':'false');btn.classList.toggle('active',active)}});return}if(b.hasAttribute('data-save-type')){saveReport(b.dataset.saveType,b.dataset.value);return}});
document.querySelectorAll('.nav-button').forEach(b=>b.addEventListener('click',()=>switchTab(b.dataset.tab)));
$('search').addEventListener('input',e=>{search=e.target.value;renderList()});$('sheet-close').addEventListener('click',closeSheet);$('sheet-backdrop').addEventListener('click',closeSheet);
$('fab-report').addEventListener('click',chooser);$('open-list-from-map').addEventListener('click',()=>switchTab('list'));
$('reset-map').addEventListener('click',()=>{ensureMap();if(map){const coords=stations.filter(s=>Number.isFinite(s.lat)&&Number.isFinite(s.lon));if(coords.length)map.fitBounds(coords.map(s=>[s.lat,s.lon]),{padding:[20,20],maxZoom:11})}});
$('reload-feed').addEventListener('click',loadPublicFeed);
$('sheet-content').addEventListener('click',e=>{
 if(e.target.id==='save-multi-availability')saveMultiAvailability();
 if(e.target.id==='save-multi-prices')saveMultiPrices();
});
$('browse-for-favs').addEventListener('click',()=>switchTab('list'));
$('quiet-hours').addEventListener('change',e=>{state.prefs.quiet=e.target.checked;save()});$('weekly-digest').addEventListener('change',e=>{state.prefs.weekly=e.target.checked;save()});
$('save-subs').addEventListener('click',async()=>{
 if(!save())return;
 if(!liveWritesEnabled()){toast('Сервер уведомлений временно недоступен');return;}
 if(!window.confirm('Подключить уведомления MAX? Идентификатор профиля и выбранные подписки будут сохранены в базе проекта.'))return;
 try{
   const preferences={...state.prefs,favorites:state.favorites,enabled:true};
   await sendCommunity('subscribe',{preferences:JSON.stringify(preferences),publicNameConsent:'YES'});
   toast('Подписки сохранены на сервере. Не забудь нажать «Начать» в боте MAX.');
 }catch(e){toast('Сервер не подтвердил подписки: '+e.message)}
});
const disable=$('disable-subs');if(disable)disable.addEventListener('click',async()=>{
 if(!window.confirm('Отключить все уведомления в MAX для этого профиля?'))return;
 if(!liveWritesEnabled()){toast('Сервер уведомлений временно недоступен');return;}
 try{await sendCommunity('subscribe',{preferences:JSON.stringify({...state.prefs,favorites:state.favorites,enabled:false}),publicNameConsent:'YES'});toast('Уведомления отключены');}
 catch(e){toast('Не удалось отключить: '+e.message)}
});
const deleteProfile=$('delete-profile');if(deleteProfile)deleteProfile.addEventListener('click',async()=>{
 if(!liveWritesEnabled()){toast('Сервер временно недоступен');return;}
 if(!window.confirm('Удалить все сообщения, подтверждения и подписки твоего профиля на сервере? Это необратимо.'))return;
 try{await sendCommunity('delete_account',{confirm:'DELETE'});toast('Данные участника удалены с сервера');setTimeout(loadPublicFeed,1500);}
 catch(e){toast('Удаление не подтверждено: '+e.message)}
});
const ratingButton=$('refresh-rating');if(ratingButton)ratingButton.addEventListener('click',async()=>{
 if(!liveWritesEnabled()){toast('Рейтинг временно недоступен');return;}
 try{const r=await sendCommunity('profile',{});$('rating-accuracy').textContent=r.accuracy===null?'—':Number(r.accuracy).toFixed(2);
 $('rating-votes').textContent=r.confirmationRating===null?'—':Number(r.confirmationRating).toFixed(2);$('rating-reports').textContent=r.verified||0;toast('Рейтинг обновлён');}
 catch(e){toast('Рейтинг пока недоступен: '+e.message)}
});
let maxNameChecks=0;const maxNameTimer=setInterval(()=>{renderMaxName();if(++maxNameChecks>=12||maxUserForDisplay())clearInterval(maxNameTimer)},600);
window.addEventListener('resize',()=>map&&setTimeout(()=>map.invalidateSize(true),150));document.addEventListener('visibilitychange',()=>{if(!document.hidden&&map&&currentTab==='map')setTimeout(()=>map.invalidateSize(true),100)});
$('summary-total').textContent=stations.length;$('summary-onmap').textContent=stations.filter(s=>Number.isFinite(s.lat)&&Number.isFinite(s.lon)).length;
try{window.WebApp?.ready?.()}catch(e){}
setupFilters();renderList();renderFavorites();renderSubscriptions();renderProfile();setTimeout(ensureMap,100);loadPublicFeed();feedTimer=setInterval(()=>{if(!document.hidden)loadPublicFeed()},5*60*1000);
})();
