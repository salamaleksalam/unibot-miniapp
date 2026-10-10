(() => {
  'use strict';
  const { regions, events } = window.MINIAPP_DATA;
  const BOT_URL = 'https://max.ru/se14329885_bot';
  const STORE_KEY = 'unibot-max-demo-regions-v1';
  const regionById = new Map(regions.map(r => [r.id, r]));
  const eventKindByRegion = new Map(events.map(e => [e.regionId, e.kind]));
  const $ = (id) => document.getElementById(id);
  const state = { tab: 'map', filter: 'all', selected: loadSelection(), map: null, markers: [] };
  let toastTimer;

  function loadSelection() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
      if (Array.isArray(parsed)) return new Set(parsed.filter(id => regionById.has(id)));
    } catch (_) { /* Private browsing can block localStorage. */ }
    return new Set();
  }
  function saveSelection() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify([...state.selected])); }
    catch (_) { toast('В этом браузере сохранение выбора недоступно'); }
  }
  function showToast(message) {
    const el = $('toast');
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
  }
  function toast(m) { showToast(m); }
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function showTab(name) {
    state.tab = name;
    document.querySelectorAll('.tab-section').forEach(section => section.classList.toggle('active', section.id === `view-${name}`));
    document.querySelectorAll('.nav-item').forEach(btn => {
      const active = btn.dataset.tab === name;
      btn.classList.toggle('active', active);
      if (active) btn.setAttribute('aria-current', 'page'); else btn.removeAttribute('aria-current');
    });
    $('page-scroll').scrollTop = 0;
    if (name === 'map') {
      if (!state.map) initMap();
      else setTimeout(() => state.map.invalidateSize(), 75);
    }
    if (name === 'regions') renderRegions();
    if (name === 'profile') renderProfile();
  }
  function createEventCard(data) {
    const region = regionById.get(data.regionId);
    const isCancel = data.kind === 'cancel';
    const root = el('article','event-card');
    root.append(el('div','event-icon' + (isCancel ? ' cancel' : ''),isCancel ? '✓' : '!'));
    const content = el('div','event-content');
    content.append(
      el('span','event-label' + (isCancel ? ' cancel' : ''), isCancel ? 'ПРИМЕР ОТМЕНЫ' : 'УЧЕБНОЕ ПРЕДУПРЕЖДЕНИЕ'),
      el('h3','',data.title),
      el('p','event-region',region ? region.name : 'Регион'),
      el('p','event-desc',data.details),
      el('span','event-meta',data.stamp),
      el('span','event-meta',data.source)
    );
    root.append(content, el('span','demo-tag','ДЕМО'));
    return root;
  }
  function renderEvents() {
    const mapList = $('map-event-list');
    const fullList = $('all-event-list');
    mapList.replaceChildren(...events.slice(0,2).map(createEventCard));
    const visible = events.filter(item => state.filter === 'all' || item.kind === state.filter);
    fullList.replaceChildren(...visible.map(createEventCard));
  }
  function toggleRegion(id) {
    const region = regionById.get(id);
    if (!region) return;
    if (state.selected.has(id)) { state.selected.delete(id); toast('Удалено из выбранных регионов'); }
    else { state.selected.add(id); toast('Регион добавлен на этом устройстве'); }
    saveSelection();
    renderRegions();
    renderProfile();
  }
  function renderRegions() {
    const q = $('region-search').value.trim().toLocaleLowerCase('ru');
    const match = regions.filter(r => r.name.toLocaleLowerCase('ru').includes(q)).sort((a,b) => a.name.localeCompare(b.name,'ru'));
    $('region-count').textContent = `${state.selected.size} выбрано`;
    $('region-list-count').textContent = `${match.length} регионов`;
    const list = $('region-list');
    if (!match.length) { list.replaceChildren(el('div','empty-result','По запросу ничего не найдено')); }
    else {
      list.replaceChildren(...match.map(region => {
        const row = el('div','region-row');
        row.append(el('span','region-bullet','⌾'), el('span','region-row-name',region.name));
        const button = el('button', state.selected.has(region.id) ? 'selected' : '', state.selected.has(region.id) ? '✓ Выбрано' : '+ Выбрать');
        button.type = 'button';
        button.addEventListener('click', () => toggleRegion(region.id));
        row.append(button);
        return row;
      }));
    }
    const chips = $('selected-chips');
    chips.replaceChildren(...[...state.selected].sort((a,b) => regionById.get(a).name.localeCompare(regionById.get(b).name, 'ru')).map(id => {
      const button = el('button','selected-chip',regionById.get(id).name);
      button.type = 'button';
      button.title = 'Удалить регион';
      button.append(el('span','', '×'));
      button.addEventListener('click', () => toggleRegion(id));
      return button;
    }));
  }
  function renderProfile() { $('profile-regions').textContent = state.selected.size; }
  function renderMaxUser() {
    try {
      // Непроверенные данные: допустимы только для визуального приветствия.
      const user = window.WebApp?.initDataUnsafe?.user;
      if (!user) return;
      const name = [user.first_name,user.last_name].filter(x => typeof x === 'string').join(' ').trim();
      if (name) {
        $('profile-name').textContent = name;
        $('profile-avatar').textContent = (user.first_name || name).trim().slice(0,1).toUpperCase();
      }
      $('profile-subtitle').textContent = 'Профиль MAX · демонстрация';
    } catch (_) { /* Outside MAX the app stays in guest mode. */ }
  }
  function markerHTML(kind) { return `<div class="region-marker ${kind || ''}" style="width:13px;height:13px"></div>`; }
  function initMap() {
    const fallback = $('map-fallback');
    if (typeof window.L === 'undefined') { fallback.hidden = false; return; }
    try {
      const map = L.map('map', { zoomControl: true, scrollWheelZoom: false, preferCanvas: true, worldCopyJump: false, minZoom: 2 });
      map.setView([60,78],3);
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 18, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a>'
      }).addTo(map);
      // Каждый кружок — условный центр региона. Это НЕ координата происшествия.
      regions.forEach(region => {
        const kind = eventKindByRegion.get(region.id) || 'unknown';
        const marker = L.marker([region.lat,region.lng], {
          icon: L.divIcon({ html: markerHTML(kind === 'unknown' ? '' : kind), className: '', iconSize: [13,13], iconAnchor:[7,7] }),
          title: region.name,
          keyboard: true
        });
        const popup = el('div','');
        popup.append(el('div','popup-title',region.name),el('div','popup-status',kind === 'alert' ? 'Учебный пример предупреждения' : kind === 'cancel' ? 'Учебный пример отмены' : 'Нет сведений (не означает безопасность)'));
        const select = el('button','popup-btn', state.selected.has(region.id) ? '✓ Убрать из выбранных' : '+ Выбрать регион');
        select.type='button';
        select.addEventListener('click', () => {
          toggleRegion(region.id);
          select.textContent = state.selected.has(region.id) ? '✓ Убрать из выбранных' : '+ Выбрать регион';
        });
        popup.append(select);
        marker.bindPopup(popup,{closeButton:true,maxWidth:260}).addTo(map);
        state.markers.push(marker);
      });
      state.map = map;
      setTimeout(() => map.invalidateSize(),100);
    } catch (_) { fallback.hidden = false; }
  }
  function initLinks() {
    ['header-bot-link','profile-bot-link'].forEach(id => {
      $(id).addEventListener('click', (evt) => {
        if (window.WebApp && typeof window.WebApp.openMaxLink === 'function') {
          evt.preventDefault();
          try { window.WebApp.openMaxLink(BOT_URL); } catch (_) { window.location.href = BOT_URL; }
        }
      });
    });
  }
  function init() {
    document.querySelectorAll('.nav-item').forEach(btn => btn.addEventListener('click', () => showTab(btn.dataset.tab)));
    document.querySelectorAll('[data-event-filter]').forEach(btn => btn.addEventListener('click', () => {
      state.filter = btn.dataset.eventFilter;
      document.querySelectorAll('[data-event-filter]').forEach(other => other.classList.toggle('active',other === btn));
      renderEvents();
    }));
    $('show-all-events').addEventListener('click',() => showTab('events'));
    $('region-search').addEventListener('input',renderRegions);
    $('reset-map').addEventListener('click',() => state.map ? state.map.setView([60,78],3,{animate:true}) : toast('Карта пока недоступна'));
    renderEvents(); renderRegions(); renderMaxUser(); renderProfile(); initLinks(); showTab('map');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded',init);
  else init();
})();
