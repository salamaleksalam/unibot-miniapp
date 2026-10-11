/* ТОПЛИВО56 v0.5: одноразовая диагностика MAX, без записи пользовательских данных. */
'use strict';
(() => {
  const button=document.getElementById('check-max-auth');
  const status=document.getElementById('max-auth-status');
  if(!button||!status)return;
  function setStatus(message){status.textContent=message;}
  function getInitData(){
    if(window.WebApp && typeof window.WebApp.initData==='string' && window.WebApp.initData)
      return window.WebApp.initData;
    try {return new URLSearchParams(location.hash.slice(1)).get('WebAppData') || '';}
    catch(_) {return '';}
  }
  button.addEventListener('click',() => {
    const api=String(window.TOPLIVO56_CONFIG?.API_URL||'');
    if(!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(api)){
      setStatus('Ошибка настройки API.');return;
    }
    const initData=getInitData();
    if(!initData){setStatus('Нет данных MAX. Открой приложение кнопкой в своём боте MAX.');return;}
    if(!crypto?.getRandomValues){setStatus('В браузере недоступна защищённая генерация идентификатора запроса.');return;}
    const bytes=new Uint8Array(16);crypto.getRandomValues(bytes);
    const requestId='req_'+Array.from(bytes,x=>x.toString(16).padStart(2,'0')).join('');
    const iframe=document.createElement('iframe');
    iframe.name='max_auth_'+requestId;
    iframe.style.display='none';
    iframe.setAttribute('aria-hidden','true');
    const form=document.createElement('form');
    form.action=api;form.method='POST';form.target=iframe.name;form.style.display='none';
    const fields={action:'auth_check',webAppData:initData,requestId};
    Object.entries(fields).forEach(([name,value])=>{
      const inp=document.createElement('input');inp.type='hidden';inp.name=name;inp.value=value;form.appendChild(inp);
    });
    button.disabled=true;
    setStatus('◌ Проверяем цифровую подпись MAX…');
    let finished=false;
    let timeout;
    const clean=()=>{
      if(finished)return;
      finished=true;
      clearTimeout(timeout);
      window.removeEventListener('message',onMessage);
      form.remove();iframe.remove();button.disabled=false;
    };
    function onMessage(event){
      // Ответ должен прийти именно из нашего одноразового iframe.
      if(event.source!==iframe.contentWindow)return;
      if(!['https://script.google.com','https://script.googleusercontent.com','null'].includes(event.origin))return;
      const msg=event.data;
      if(!msg || typeof msg!=='object' || msg.channel!=='toplivo56-write' || msg.requestId!==requestId)return;
      clean();
      if(msg.ok===true && msg.authenticated===true && msg.build==='0.5-auth'){
        setStatus('✅ Авторизация MAX подтверждена сервером. Запись сообщений пока отключена.');
      }else{
        setStatus('❌ '+String(msg.error||'Сервер отклонил проверку.'));
      }
    }
    timeout=setTimeout(()=>{clean();setStatus('⚠️ Нет ответа в течение 35 секунд. Повтори тест после перезапуска MAX.');},35000);
    window.addEventListener('message',onMessage);
    document.body.appendChild(iframe);document.body.appendChild(form);
    try {form.submit();}
    catch(_) {clean();setStatus('Не удалось отправить запрос.');}
  });
})();
