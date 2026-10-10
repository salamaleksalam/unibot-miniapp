(() => {
  'use strict';
  const { regions, events: demoEvents } = window.MINIAPP_DATA;
  const BOT_URL = 'https://max.ru/se14329885_bot';
  const STORE_KEY = 'unibot-max-demo-regions-v1';
  const FEED_URL = (window.UNIBOT_CONFIG?.publicFeedUrl || '').trim();
  const regionById = new Map(regions.map(r => [r.id, r]));
  const regionByName = new Map(regions.map(r => [r.name, r]));
  const $ = id => document.getElementById(id);
  const state = { tab:'map', filter:'all', selected:loadSelection(), map:null, markers:[], events: FEED_URL ? [] : demoEvents, feedState: FEED_URL ? 'loading' : 'demo' };
  let toastTimer, feedSequence = 0;
  let mapResizeObserver;
  const RUSSIA_BOUNDS = [[41,19],[78,190]];
  function loadSelection() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
      if (Array.isArray(parsed)) return new Set(parsed.filter(id => regionById.has(id)));
    } catch (_) {}
    return new Set();
  }
  function saveSelection() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify([...state.selected])); }
    catch (_) { showToast('Сохранение выбора недоступно'); }
  }
  function showToast(message) {
    const node=$('toast'); node.textContent=message; node.classList.add('show');
    clearTimeout(toastTimer); toastTimer=setTimeout(()=>node.classList.remove('show'),2400);
  }
  function el(tag, className, text) {
    const node=document.createElement(tag);
    if (className) node.className=className;
    if (text !== undefined) node.textContent=text;
    return node;
  }
  function showTab(name) {
    state.tab=name;
    document.querySelectorAll('.tab-section').forEach(section=>section.classList.toggle('active',section.id===`view-${name}`));
    document.querySelectorAll('.nav-item').forEach(btn=>{
      const active=btn.dataset.tab===name;
      btn.classList.toggle('active',active);
      if(active) btn.setAttribute('aria-current','page'); else btn.removeAttribute('aria-current');
    });
    $('page-scroll').scrollTop=0;
    if(name==='map') {
      if(!state.map) initMap(); else scheduleMapRefresh();
    }
    if(name==='regions') renderRegions();
    if(name==='profile') renderProfile();
  }
  function addLink(parent, url, text) {
    if (!/^https:\/\//i.test(url||'')) return;
    const link=el('a','source-link',text);
    link.href=url; link.target='_blank'; link.rel='noopener noreferrer';
    parent.append(link);
  }
  function createEventCard(data) {
    const region=regionById.get(data.regionId);
    const isCancel=data.kind==='cancel';
    const root=el('article','event-card');
    root.append(el('div','event-icon'+(isCancel?' cancel':''),isCancel?'✓':'!'));
    const content=el('div','event-content');
    const demo=state.feedState==='demo';
    content.append(
      el('span','event-label'+(isCancel?' cancel':''), demo?(isCancel?'ПРИМЕР ОТМЕНЫ':'УЧЕБНОЕ ПРЕДУПРЕЖДЕНИЕ'):(isCancel?'ОТМЕНА':'ПРЕДУПРЕЖДЕНИЕ')),
      el('h3','',data.title),
      el('p','event-region',region ? region.name:'Регион'),
      el('p','event-desc',data.details || ''),
      el('span','event-meta',data.stamp || '')
    );
    if(data.sourceUrl) addLink(content,data.sourceUrl,'Официальный источник ↗');
    else if(demo) content.append(el('span','event-meta','Источник не подключён'));
    root.append(content);
    if(demo) root.append(el('span','demo-tag','ДЕМО'));
    return root;
  }
  function renderEvents() {
    const emptyMsg=state.feedState==='error'?'Не удалось получить данные. Проверьте официальные источники.':
      state.feedState==='loading'?'Загружаем подтверждённые публикации…':'Опубликованных событий нет.';
    const mapEvents=state.events.slice(0,2);
    $('map-event-list').replaceChildren(...(mapEvents.length ? mapEvents.map(createEventCard) : [el('div','empty-result',emptyMsg)]));
    const visible=state.events.filter(item=>state.filter==='all'||item.kind===state.filter);
    $('all-event-list').replaceChildren(...(visible.length ? visible.map(createEventCard) : [el('div','empty-result',emptyMsg)]));
  }
  function toggleRegion(id) {
    if(!regionById.has(id)) return;
    if(state.selected.has(id)) {state.selected.delete(id);showToast('Удалено из выбранных регионов');}
    else {state.selected.add(id);showToast('Регион сохранён на этом устройстве');}
    saveSelection();renderRegions();renderProfile();
  }
  function renderRegions() {
    const q=$('region-search').value.trim().toLocaleLowerCase('ru');
    const match=regions.filter(r=>r.name.toLocaleLowerCase('ru').includes(q)).sort((a,b)=>a.name.localeCompare(b.name,'ru'));
    $('region-count').textContent=`${state.selected.size} выбрано`;
    $('region-list-count').textContent=`${match.length} регионов`;
    $('region-list').replaceChildren(...(match.length?match.map(region=>{
      const row=el('div','region-row');
      row.append(el('span','region-bullet','⌾'),el('span','region-row-name',region.name));
      const btn=el('button',state.selected.has(region.id)?'selected':'',state.selected.has(region.id)?'✓ Выбрано':'+ Выбрать');
      btn.type='button';btn.addEventListener('click',()=>toggleRegion(region.id));
      row.append(btn);return row;
    }):[el('div','empty-result','По запросу ничего не найдено')]));
    $('selected-chips').replaceChildren(...[...state.selected].sort((a,b)=>regionById.get(a).name.localeCompare(regionById.get(b).name,'ru')).map(id=>{
      const btn=el('button','selected-chip',regionById.get(id).name);btn.type='button';btn.title='Удалить регион';
      btn.append(el('span','','×'));btn.addEventListener('click',()=>toggleRegion(id));return btn;
    }));
  }
  function renderProfile() { $('profile-regions').textContent=state.selected.size; }
  function renderMaxUser() {
    try {
      // initDataUnsafe нельзя использовать для авторизации.
      const user=window.WebApp?.initDataUnsafe?.user;
      if(!user) return;
      const name=[user.first_name,user.last_name].filter(x=>typeof x==='string').join(' ').trim();
      if(name) { $('profile-name').textContent=name; $('profile-avatar').textContent=(user.first_name||name).trim().slice(0,1).toUpperCase(); }
      $('profile-subtitle').textContent='Профиль MAX · имя не проверено';
    } catch (_) {}
  }
  function markerHTML(kind) { return `<div class="region-marker ${kind||''}" style="width:13px;height:13px"></div>`; }
  function latestRegionStatus(regionId) {
    if(state.feedState==='error'||state.feedState==='loading') return {kind:'unknown',text:'Свежие сведения недоступны'};
    const candidate=state.events.find(item=>item.regionId===regionId);
    if(!candidate) return {kind:'unknown',text:'Нет опубликованных сведений (не означает безопасность)'};
    if(state.feedState==='demo') return {kind:candidate.kind,text:candidate.kind==='alert'?'Учебный пример предупреждения':'Учебный пример отмены'};
    const age=Date.now()-Date.parse(candidate.timestamp);
    if(!Number.isFinite(age)||age < -600000 || age > 24*3600*1000) {
      return {kind:'unknown',text:'Последняя публикация старше 24 часов. Сведения могут быть устаревшими'};
    }
    return {kind:candidate.kind,text:(candidate.kind==='alert'?'Опубликовано предупреждение':'Опубликована отмена')+' · '+candidate.stamp};
  }
  function drawMarkers() {
    if(!state.map || typeof window.L==='undefined') return;
    state.markers.forEach(marker=>state.map.removeLayer(marker)); state.markers=[];
    regions.forEach(region=>{
      const status=latestRegionStatus(region.id);
      const marker=L.marker([region.lat,region.lng],{
        icon:L.divIcon({html:markerHTML(status.kind==='unknown'?'':status.kind),className:'',iconSize:[13,13],iconAnchor:[7,7]}),
        title:region.name,keyboard:true
      });
      const popup=el('div','');
      popup.append(el('div','popup-title',region.name),el('div','popup-status',status.text));
      const select=el('button','popup-btn',state.selected.has(region.id)?'✓ Убрать из выбранных':'+ Выбрать регион');
      select.type='button';select.addEventListener('click',()=>{
        toggleRegion(region.id);
        select.textContent=state.selected.has(region.id)?'✓ Убрать из выбранных':'+ Выбрать регион';
      });
      popup.append(select);marker.bindPopup(popup,{closeButton:true,maxWidth:260}).addTo(state.map);state.markers.push(marker);
    });
  }
  function refreshMapSize() {
    if (!state.map || state.tab !== 'map') return;
    const box = $('map').getBoundingClientRect();
    if (box.width < 100 || box.height < 100) return;
    state.map.invalidateSize({pan:false, animate:false});
  }
  function scheduleMapRefresh() {
    [0,150,450,900,1600].forEach(delay => setTimeout(refreshMapSize, delay));
  }
  function showRussiaOverview() {
    if (!state.map) return;
    refreshMapSize();
    state.map.fitBounds(RUSSIA_BOUNDS, {padding:[15,15], maxZoom:3, animate:false});
    scheduleMapRefresh();
  }
  function initMap() {
    if(typeof window.L==='undefined') { $('map-fallback').hidden=false;return; }
    try {
      const map=L.map('map',{
        zoomControl:true,scrollWheelZoom:false,preferCanvas:true,
        worldCopyJump:false,minZoom:1,zoomSnap:0.25,zoomDelta:0.5
      });
      state.map=map;
      map.setView([60,98],2);
      const tileLayer=L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{
        maxZoom:18,
        attribution:'&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a>'
      });
      tileLayer.addTo(map);
      drawMarkers();
      showRussiaOverview();
      if (typeof ResizeObserver !== 'undefined') {
        mapResizeObserver = new ResizeObserver(() => refreshMapSize());
        mapResizeObserver.observe($('map'));
      }
      window.addEventListener('resize', scheduleMapRefresh, {passive:true});
      window.addEventListener('orientationchange', scheduleMapRefresh, {passive:true});
      window.addEventListener('pageshow', scheduleMapRefresh);
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) scheduleMapRefresh();
      });
      scheduleMapRefresh();
    } catch (error) { console.error('Map init failed', error); $('map-fallback').hidden=false; }
  }
  function setFeedStatus(name) {
    state.feedState=name;
    const data={
      demo:['ДЕМО-ВЕРСИЯ','Учебные события. База данных пока не подключена.','● ПРОТОТИП','Пример отображения статусов','Учебные отметки','Примеры сообщений','Ниже — учебные примеры.'],
      loading:['ЗАГРУЗКА','Получаем опубликованные сообщения из базы.','● ОБНОВЛЕНИЕ','Ожидание информации','Загрузка…','Последние сообщения','Загружаем данные.'],
      live:['ПРОВЕРЕННЫЕ ПУБЛИКАЦИИ','События вручную подтверждены администратором. Это не официальный сервис экстренного оповещения.','● БАЗА ПОДКЛЮЧЕНА','Региональные публикации · обновление каждые 5 минут','Регионы, не координаты событий','Последние сообщения','Информация публикуется вручную, возможны задержки. Всегда проверяйте первоисточник.'],
      error:['НЕТ СВЯЗИ С БАЗОЙ','Не удалось загрузить публикации. Это не означает отсутствие предупреждений.','● НЕТ ДАННЫХ','Информация недоступна','Нет связи','Последние сообщения','База временно недоступна. Используйте официальные каналы оповещения.']
    }[name];
    $('feed-banner-title').textContent=data[0];
    $('feed-banner-description').textContent=data[1];
    $('feed-status').textContent=data[2];
    $('map-summary').textContent=data[3];
    $('map-corner').textContent=data[4];
    $('map-feed-heading').textContent=data[5];
    $('feed-caption').textContent=data[6];
  }
  function redrawFeed() { renderEvents(); if(state.map) drawMarkers(); }
  function loadEvents() {
    if(!/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec(?:\?.*)?$/.test(FEED_URL)) {
      state.events=[];setFeedStatus('error');redrawFeed();return;
    }
    const seq=++feedSequence;
    const cb='unibotFeed_'+seq+'_'+Date.now();
    const script=document.createElement('script');
    const timeout=setTimeout(()=>cleanup(false),18000);
    function cleanup(success) {
      clearTimeout(timeout);script.remove();delete window[cb];
      if(!success && seq===feedSequence) {state.events=[];setFeedStatus('error');redrawFeed();}
    }
    window[cb]=(payload)=>{
      if(seq!==feedSequence) {cleanup(true);return;}
      if(!payload || payload.ok!==true || !Array.isArray(payload.events)) {cleanup(false);return;}
      const clean=payload.events.slice(0,100).map(item=>{
        const region=regionByName.get(item.region);
        if(!region||!['alert','cancel'].includes(item.kind)) return null;
        return {id:String(item.id||''),regionId:region.id,kind:item.kind,
          title:String(item.title||'').slice(0,200),details:String(item.details||'').slice(0,1000),
          stamp:String(item.stamp||''),timestamp:String(item.timestamp||''),sourceUrl:String(item.sourceUrl||'')};
      }).filter(Boolean);
      state.events=clean;setFeedStatus('live');redrawFeed();cleanup(true);
    };
    script.onerror=()=>cleanup(false);
    script.src=FEED_URL+(FEED_URL.includes('?')?'&':'?')+'callback='+encodeURIComponent(cb)+'&nocache='+Date.now();
    document.head.append(script);
  }
  function initLinks() {
    ['header-bot-link','profile-bot-link'].forEach(id=>{
      $(id).addEventListener('click',evt=>{
        if(window.WebApp && typeof window.WebApp.openMaxLink==='function') {
          evt.preventDefault();try{window.WebApp.openMaxLink(BOT_URL);} catch (_){window.location.href=BOT_URL;}
        }
      });
    });
  }
  function init() {
    document.querySelectorAll('.nav-item').forEach(btn=>btn.addEventListener('click',()=>showTab(btn.dataset.tab)));
    document.querySelectorAll('[data-event-filter]').forEach(btn=>btn.addEventListener('click',()=>{
      state.filter=btn.dataset.eventFilter;
      document.querySelectorAll('[data-event-filter]').forEach(other=>other.classList.toggle('active',other===btn));
      renderEvents();
    }));
    $('show-all-events').addEventListener('click',()=>showTab('events'));
    $('region-search').addEventListener('input',renderRegions);
    $('reset-map').addEventListener('click',()=>state.map?showRussiaOverview():showToast('Карта пока недоступна'));
    setFeedStatus(FEED_URL?'loading':'demo');
    renderEvents();renderRegions();renderMaxUser();renderProfile();initLinks();showTab('map');
    if(FEED_URL) {
      loadEvents();setInterval(loadEvents,300000);
      document.addEventListener('visibilitychange',()=>{if(!document.hidden)loadEvents();});
    }
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',init);else init();
})();
