/* ============================================================
 * KuponStore YS — Adres Modal
 * Mobil: 2 adım (1 Konum → 2 Detay). Masaüstü: yan yana.
 * window.KS_OpenAddressModal({ onSave, initial })
 * ============================================================ */

(() => {
  'use strict';

  const IST = { lat: 41.0082, lng: 28.9784 };
  const PARENT_SOURCE = 'kuponstore-extension';
  const MAPS_SOURCE = 'kuponstore-maps';

  function el(tag, attrs, ...children) {
    const n = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') n.className = v;
      else if (k === 'style') n.style.cssText = v;
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) n.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children) {
      if (c == null || c === false) continue;
      n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return n;
  }

  function setVal(root, name, value) {
    const inp = root.querySelector('[name="' + name + '"]');
    if (!inp || value == null || value === '') return;
    inp.value = String(value);
  }

  function getVal(root, name) {
    const inp = root.querySelector('[name="' + name + '"]');
    return inp ? String(inp.value || '').trim() : '';
  }

  function lockBody() {
    try {
      document.body.dataset.ksScrollY = String(window.scrollY || 0);
      document.documentElement.style.overflow = 'hidden';
      document.body.style.overflow = 'hidden';
      document.body.style.position = 'fixed';
      document.body.style.width = '100%';
      document.body.style.top = '-' + (document.body.dataset.ksScrollY || '0') + 'px';
    } catch (_) {}
  }

  function unlockBody() {
    try {
      const y = document.body.dataset.ksScrollY != null
        ? (parseInt(document.body.dataset.ksScrollY, 10) || 0)
        : null;
      delete document.body.dataset.ksScrollY;
      document.documentElement.style.removeProperty('overflow');
      document.documentElement.style.overflowY = 'scroll';
      document.body.style.removeProperty('overflow');
      document.body.style.removeProperty('position');
      document.body.style.removeProperty('width');
      document.body.style.removeProperty('top');
      document.body.style.removeProperty('height');
      document.body.style.removeProperty('touch-action');
      document.body.style.height = 'auto';
      document.body.style.overflow = 'visible';
      document.body.style.position = 'static';
      if (y != null) window.scrollTo(0, y);
    } catch (_) {}
  }

  function postToMap(iframe, payload) {
    try {
      if (!iframe || !iframe.contentWindow) return;
      iframe.contentWindow.postMessage(
        Object.assign({ source: PARENT_SOURCE }, payload),
        '*'
      );
    } catch (e) {
      console.warn('[KS Addr] postToMap:', e);
    }
  }

  function field(lbl, name, placeholder, type, required, value) {
    return el('label', { class: 'ks-field' },
      el('span', { class: 'ks-field-lbl' }, lbl + (required ? ' *' : '')),
      el('input', {
        class: 'ks-field-inp',
        type: type || 'text',
        name,
        placeholder: placeholder || '',
        value: value != null ? String(value) : '',
        required: !!required,
        autocomplete: 'off',
        inputmode: type === 'tel' ? 'numeric' : undefined,
      })
    );
  }

  async function openAddressModal({ onSave, initial } = {}) {
    const data = Object.assign({
      title: '',
      label: 'home',
      city: '',
      areas: '',
      street: '',
      building: '',
      floor: '',
      entrance: '',
      phone_number: '',
      first_name: '',
      last_name: '',
      description: '',
      delivery_instructions: '',
      latitude: IST.lat,
      longitude: IST.lng,
      isDefault: false,
    }, initial || {});
    if (!data.description && data.delivery_instructions) {
      data.description = data.delivery_instructions;
    }

    let startLat = parseFloat(data.latitude) || IST.lat;
    let startLng = parseFloat(data.longitude) || IST.lng;
    let hasPin = !!(initial && initial.latitude && initial.longitude);
    let mapReady = false;
    let searchTimer = null;
    let iframe = null;
    let step = 1; // 1=konum, 2=detay

    const root = el('div', {
      class: 'ks-addr-root',
      role: 'dialog',
      'aria-modal': 'true',
    });

    const stepTitle = el('div', { class: 'ks-addr-title' },
      initial ? 'Adresi Düzenle' : 'Yeni Adres'
    );
    const stepSub = el('div', { class: 'ks-addr-sub' }, '1/2 · Konumu seç');
    const stepDots = el('div', { class: 'ks-addr-steps', 'aria-hidden': 'true' },
      el('span', { class: 'ks-step-dot is-on', 'data-s': '1' }),
      el('span', { class: 'ks-step-dot', 'data-s': '2' })
    );

    let onResize = null;
    function onKey(ev) {
      if (ev.key === 'Escape') close();
    }
    function close() {
      window.removeEventListener('message', onMessage);
      document.removeEventListener('keydown', onKey);
      if (onResize) window.removeEventListener('resize', onResize);
      unlockBody();
      root.classList.remove('is-open');
      setTimeout(() => root.remove(), 200);
    }

    const header = el('header', { class: 'ks-addr-head' },
      el('button', {
        type: 'button',
        class: 'ks-addr-back',
        id: 'ksAddrBack',
        'aria-label': 'Geri',
        style: 'visibility:hidden',
        onclick: () => goStep(1),
      }, el('span', { class: 'material-symbols-rounded' }, 'arrow_back')),
      el('div', { class: 'ks-addr-head-text' }, stepTitle, stepSub, stepDots),
      el('button', {
        type: 'button',
        class: 'ks-addr-close',
        'aria-label': 'Kapat',
        onclick: close,
      }, el('span', { class: 'material-symbols-rounded' }, 'close'))
    );

    /* ── Step 1: Konum ── */
    const suggestBox = el('div', { class: 'ks-addr-suggest', style: 'display:none' });
    const searchInp = el('input', {
      class: 'ks-field-inp ks-map-search',
      type: 'search',
      placeholder: 'Adres ara… (Kadıköy Moda)',
      autocomplete: 'off',
      enterkeyhint: 'search',
    });
    const mapStatus = el('div', { class: 'ks-map-status' }, 'Adres arayın veya haritaya dokunun');
    const mapPlaceholder = el('div', { class: 'ks-map-placeholder' },
      el('span', { class: 'material-symbols-rounded' }, 'explore'),
      el('span', {}, 'Harita yükleniyor…')
    );

    window.addEventListener('message', onMessage);

    const extId = (chrome && chrome.runtime && chrome.runtime.id) || '';
    const mapUrl = 'https://kuponstore.com/extension/maps.html?ext=' +
      encodeURIComponent(extId) + '&v=' + Date.now();
    iframe = el('iframe', {
      class: 'ks-map-iframe',
      src: mapUrl,
      allow: 'geolocation',
      referrerPolicy: 'strict-origin-when-cross-origin',
      title: 'Google Harita',
    });
    iframe.addEventListener('load', () => {
      postToMap(iframe, { type: 'requestMapReady' });
      postToMap(iframe, { type: 'forceResize' });
    });
    const mapHost = el('div', { class: 'ks-map-host' }, mapPlaceholder, iframe);

    const btnNext = el('button', {
      type: 'button',
      class: 'ks-btn primary ks-btn-block',
      disabled: !hasPin,
      onclick: () => {
        if (!hasPin) {
          alert('Önce haritadan konum seçin.');
          return;
        }
        goStep(2);
      },
    },
      el('span', {}, 'Devam · Adres detayı'),
      el('span', { class: 'material-symbols-rounded' }, 'arrow_forward')
    );

    const step1 = el('section', { class: 'ks-addr-pane is-active', 'data-step': '1' },
      el('div', { class: 'ks-map-search-wrap' },
        el('span', { class: 'material-symbols-rounded ks-map-search-ic' }, 'search'),
        searchInp,
        el('button', {
          type: 'button',
          class: 'ks-map-geo-btn',
          title: 'Konumum',
          onclick: useMyLocation,
        }, el('span', { class: 'material-symbols-rounded' }, 'my_location'))
      ),
      suggestBox,
      mapHost,
      mapStatus,
      el('p', { class: 'ks-map-hint' },
        'Google Maps’teki gibi aratın, pin’i evin üstüne koyun.'),
      btnNext
    );

    /* ── Step 2: Detay formu ── */
    const form = el('form', { class: 'ks-addr-form-fields', id: 'ksAddrForm', autocomplete: 'off' },
      el('div', { class: 'ks-picked' },
        el('span', { class: 'material-symbols-rounded' }, 'location_on'),
        el('span', { class: 'ks-picked-text', id: 'ksPickedText' }, mapStatus.textContent)
      ),

      el('div', { class: 'ks-addr-grid' },
        field('Başlık', 'title', 'Ev / İş', 'text', true, data.title),
        el('label', { class: 'ks-field' },
          el('span', { class: 'ks-field-lbl' }, 'Etiket'),
          el('select', { class: 'ks-field-inp', name: 'label' },
            el('option', { value: 'home', selected: data.label === 'home' }, 'Ev'),
            el('option', { value: 'work', selected: data.label === 'work' }, 'İş'),
            el('option', { value: 'other', selected: data.label === 'other' }, 'Diğer')
          )
        )
      ),
      el('div', { class: 'ks-addr-grid' },
        field('Şehir', 'city', 'İstanbul', 'text', true, data.city),
        field('Mahalle', 'areas', 'Mahalle', 'text', false, data.areas)
      ),
      field('Cadde / Sokak', 'street', 'Cadde', 'text', false, data.street),
      el('div', { class: 'ks-addr-grid ks-grid-3' },
        field('Bina No', 'building', '12', 'text', false, data.building),
        field('Daire', 'entrance', '7', 'text', false, data.entrance),
        field('Kat', 'floor', '3', 'text', false, data.floor)
      ),
      el('div', { class: 'ks-addr-grid' },
        field('Ad', 'first_name', 'Ad', 'text', false, data.first_name),
        field('Soyad', 'last_name', 'Soyad', 'text', false, data.last_name)
      ),
      field('Telefon', 'phone_number', '5XXXXXXXXX', 'tel', false, data.phone_number),

      el('label', { class: 'ks-field' },
        el('span', { class: 'ks-field-lbl' }, 'Adres Tarifi'),
        el('textarea', {
          class: 'ks-field-inp ks-field-ta',
          name: 'description',
          rows: '3',
          maxlength: '50',
          placeholder: 'Kapı zili, tarif… (maks. 50)',
        }, data.description || ''),
        el('div', { class: 'ks-field-meta' },
          el('span', { class: 'ks-field-hint' }, 'Kurye için kısa tarif yazın.'),
          el('span', { class: 'ks-field-counter', id: 'ksDescCounter' },
            String((data.description || '').length) + '/50')
        )
      ),

      el('input', { type: 'hidden', name: 'latitude', value: String(startLat) }),
      el('input', { type: 'hidden', name: 'longitude', value: String(startLng) }),

      el('label', { class: 'ks-addr-switch' },
        el('input', { type: 'checkbox', name: 'isDefault', checked: !!data.isDefault }),
        el('span', { class: 'ks-switch-slider' }),
        el('span', { class: 'ks-addr-switch-lbl' }, 'Varsayılan adres yap')
      )
    );

    const btnSave = el('button', {
      type: 'submit',
      class: 'ks-btn primary ks-btn-block',
      form: 'ksAddrForm',
    },
      el('span', { class: 'material-symbols-rounded' }, 'save'),
      el('span', {}, initial ? 'Güncelle' : 'Kaydet')
    );

    const step2 = el('section', { class: 'ks-addr-pane', 'data-step': '2' },
      el('div', { class: 'ks-addr-scroll' }, form),
      el('div', { class: 'ks-addr-foot' }, btnSave)
    );

    function layoutStep2Scroll() {
      try {
        const scroll = step2.querySelector('.ks-addr-scroll');
        const foot = step2.querySelector('.ks-addr-foot');
        if (!scroll) return;
        // Pane absolute + px yükseklik → WebView scroll kesin açılsın
        const paneH = step2.clientHeight || card.clientHeight;
        const footH = foot ? foot.offsetHeight : 0;
        const h = Math.max(120, paneH - footH);
        scroll.style.height = h + 'px';
        scroll.style.maxHeight = h + 'px';
        scroll.style.overflowY = 'auto';
        scroll.style.webkitOverflowScrolling = 'touch';
        scroll.style.touchAction = 'pan-y';
        scroll.scrollTop = 0;
      } catch (_) {}
    }

    function goStep(n) {
      step = n;
      step1.classList.toggle('is-active', n === 1);
      step2.classList.toggle('is-active', n === 2);
      root.classList.toggle('ks-step-2', n === 2);
      const back = root.querySelector('#ksAddrBack');
      if (back) back.style.visibility = n === 2 ? 'visible' : 'hidden';
      stepSub.textContent = n === 1 ? '1/2 · Konumu seç' : '2/2 · Adres detayı';
      root.querySelectorAll('.ks-step-dot').forEach((d) => {
        d.classList.toggle('is-on', d.getAttribute('data-s') === String(n));
      });
      if (n === 1) {
        requestAnimationFrame(() => {
          postToMap(iframe, { type: 'forceResize' });
          try { searchInp.focus(); } catch (_) {}
        });
      } else {
        const picked = root.querySelector('#ksPickedText');
        if (picked) picked.textContent = mapStatus.textContent || 'Konum seçildi';
        requestAnimationFrame(() => {
          layoutStep2Scroll();
          // klavye açılınca yeniden ölç
          setTimeout(layoutStep2Scroll, 80);
          setTimeout(layoutStep2Scroll, 320);
        });
      }
    }

    function markPin(ok) {
      hasPin = !!ok;
      btnNext.disabled = !hasPin;
      if (ok) mapStatus.classList.add('ok');
      else mapStatus.classList.remove('ok');
    }

    function applyGoogleAddress(payload) {
      if (!payload) return;
      const il = String(payload.province || payload.il || '').replace(/\s+ili$/i, '').trim();
      const ilce = String(payload.district || payload.ilce || '').replace(/\s+ilçesi$/i, '').trim();
      const mahalle = String(payload.neighborhood || payload.mahalle || '')
        .replace(/\s+(mahallesi|mah\.?)$/i, '').trim();
      const cadde = payload.street || payload.cadde || '';
      const no = payload.building || payload.no || '';
      const lat = payload.latitude != null ? Number(payload.latitude) : null;
      const lng = payload.longitude != null ? Number(payload.longitude) : null;

      setVal(form, 'city', il);
      setVal(form, 'areas', mahalle || ilce);
      setVal(form, 'street', cadde);
      if (no) setVal(form, 'building', String(no).replace(/^No:\s*/i, ''));
      if (lat != null && !Number.isNaN(lat)) {
        setVal(form, 'latitude', lat.toFixed(6));
        startLat = lat;
      }
      if (lng != null && !Number.isNaN(lng)) {
        setVal(form, 'longitude', lng.toFixed(6));
        startLng = lng;
      }

      const title = form.querySelector('[name="title"]');
      if (title && (!title.value || title.dataset.auto === '1')) {
        title.value = ilce || il || mahalle || 'Adres';
        title.dataset.auto = '1';
      }

      const label = payload.formattedAddress ||
        [mahalle, cadde, ilce, il].filter(Boolean).join(', ') ||
        'Konum seçildi';
      mapStatus.textContent = label;
      markPin(true);
    }

    function onMessage(ev) {
      const msg = ev.data;
      if (!msg || msg.source !== MAPS_SOURCE) return;

      if (msg.type === 'mapReady') {
        mapReady = true;
        mapPlaceholder.style.display = 'none';
        iframe.classList.add('is-ready');
        postToMap(iframe, { type: 'forceResize' });
        postToMap(iframe, {
          type: 'setLocation',
          latitude: startLat,
          longitude: startLng,
        });
        return;
      }

      if (msg.type === 'searchResults' && Array.isArray(msg.data)) {
        const preds = msg.data;
        if (!preds.length) {
          suggestBox.style.display = 'none';
          suggestBox.innerHTML = '';
          return;
        }
        suggestBox.innerHTML = '';
        preds.slice(0, 6).forEach((p) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'ks-suggest-item';
          const main = p.main_text || p.description || '';
          const sec = p.secondary_text || '';
          b.innerHTML = '<div class="ks-suggest-main"></div>' +
            (sec ? '<div class="ks-suggest-sec"></div>' : '');
          b.querySelector('.ks-suggest-main').textContent = main;
          const secEl = b.querySelector('.ks-suggest-sec');
          if (secEl) secEl.textContent = sec;
          b.onclick = () => {
            suggestBox.style.display = 'none';
            searchInp.value = p.description || main;
            if (p.place_id) {
              mapStatus.textContent = 'Konum seçiliyor…';
              mapStatus.classList.remove('ok');
              postToMap(iframe, {
                type: 'selectPlace',
                placeId: p.place_id,
                description: p.description || main || '',
              });
            }
          };
          suggestBox.appendChild(b);
        });
        suggestBox.style.display = 'block';
        return;
      }

      if (msg.type === 'addressSelected' && msg.data) {
        applyGoogleAddress(msg.data);
      }
    }

    function useMyLocation() {
      if (!navigator.geolocation) {
        alert('Tarayıcı konum desteklemiyor.');
        return;
      }
      mapStatus.textContent = 'Konum alınıyor…';
      mapStatus.classList.remove('ok');
      navigator.geolocation.getCurrentPosition(
        (p) => {
          postToMap(iframe, {
            type: 'setLocation',
            latitude: p.coords.latitude,
            longitude: p.coords.longitude,
          });
        },
        (err) => alert('Konum alınamadı: ' + err.message),
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
      );
    }

    const descTa = form.querySelector('textarea[name="description"]');
    const descCounter = form.querySelector('#ksDescCounter');
    if (descTa && descCounter) {
      descTa.addEventListener('input', () => {
        descCounter.textContent = String(descTa.value.length) + '/50';
      });
    }

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const lat = parseFloat(getVal(form, 'latitude')) || null;
      const lng = parseFloat(getVal(form, 'longitude')) || null;
      if (!lat || !lng) {
        alert('Konum eksik. Haritaya dönüp pin seçin.');
        goStep(1);
        return;
      }
      if (!getVal(form, 'city')) {
        alert('Şehir zorunlu.');
        return;
      }
      if (!getVal(form, 'title')) {
        alert('Başlık zorunlu.');
        return;
      }

      const addr = {
        title: getVal(form, 'title'),
        label: getVal(form, 'label') || 'home',
        city: getVal(form, 'city'),
        areas: getVal(form, 'areas'),
        street: getVal(form, 'street'),
        building: getVal(form, 'building'),
        entrance: getVal(form, 'entrance'),
        floor: getVal(form, 'floor'),
        first_name: getVal(form, 'first_name'),
        last_name: getVal(form, 'last_name'),
        phone_number: getVal(form, 'phone_number'),
        description: getVal(form, 'description').slice(0, 50),
        isDefault: !!form.querySelector('[name="isDefault"]').checked,
        latitude: lat,
        longitude: lng,
      };
      addr.delivery_instructions = addr.description;
      addr.formatted_customer_address = [addr.areas, addr.street, addr.building, addr.city]
        .filter(Boolean).join(', ');
      addr.address_line1 = addr.street;
      addr.address_line2 = addr.building;
      addr.address_line3 = addr.areas;
      addr.flat_number = addr.entrance || '1';
      addr.lat = addr.latitude;
      addr.lng = addr.longitude;

      if (initial && initial.id) addr.id = initial.id;
      if (initial && initial.place_id) addr.place_id = initial.place_id;
      if (initial && initial.form_id) addr.form_id = initial.form_id;
      if (!addr.id && !addr.place_id && !addr.form_id) addr.id = 'addr_' + Date.now();

      try { onSave && onSave(addr); } catch (err) { console.error('[KS Addr] onSave:', err); }
      close();
    });

    searchInp.addEventListener('input', () => {
      clearTimeout(searchTimer);
      const q = searchInp.value.trim();
      if (q.length < 3) {
        suggestBox.style.display = 'none';
        suggestBox.innerHTML = '';
        return;
      }
      searchTimer = setTimeout(() => {
        if (!mapReady) {
          mapStatus.textContent = 'Harita henüz hazır değil…';
          return;
        }
        postToMap(iframe, { type: 'searchAddress', query: q });
      }, 280);
    });

    const body = el('div', { class: 'ks-addr-body' }, step1, step2);
    const card = el('div', { class: 'ks-addr-card' },
      el('div', { class: 'ks-addr-grab', 'aria-hidden': 'true' }),
      header,
      body
    );

    root.appendChild(el('div', { class: 'ks-addr-backdrop', onclick: close }));
    root.appendChild(card);
    document.body.appendChild(root);
    lockBody();

    onResize = () => {
      try {
        const h = Math.round(window.innerHeight);
        card.style.height = h + 'px';
        card.style.maxHeight = h + 'px';
        if (step === 2) layoutStep2Scroll();
      } catch (_) {}
    };
    onResize();
    window.addEventListener('resize', onResize);
    document.addEventListener('keydown', onKey);

    requestAnimationFrame(() => {
      root.classList.add('is-open');
      goStep(1);
      setTimeout(() => { try { searchInp.focus(); } catch (_) {} }, 220);
    });
  }

  window.KS_OpenAddressModal = openAddressModal;
  window.KS_AddressModal = { open: openAddressModal };
})();
