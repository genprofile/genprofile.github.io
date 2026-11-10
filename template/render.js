// Đọc dữ liệu portfolio và dựng trang.
// - Chạy độc lập: đọc data.json (xem loadData).
// - Preview trong generator (index.html?preview): nhận dữ liệu qua postMessage.
// Script thường (không phải module) để vẫn chạy khi mở bằng file://.

const app = document.getElementById('app');
const isPreview = new URLSearchParams(location.search).has('preview');
const canAnimate =
  'IntersectionObserver' in window && !matchMedia('(prefers-reduced-motion: reduce)').matches;
let observer = null;
let hasRendered = false;
let pendingScroll = ''; // section generator muốn xem nhưng chưa có (đang rỗng)
let activeTab = null; // thẻ điều hướng đang được highlight

const THEMES = ['minimal', 'dark', 'gradient', 'gradient-dark', 'beige']; // màu, xem style.css
const LAYOUTS = ['classic', 'sidebar', 'resume', 'bento', 'editorial', 'magazine', 'card']; // bố cục, xem style.css
const CARD_EFFECTS = ['none', 'shadow', 'glow', 'highlight', 'outline']; // hiệu ứng chữ của card visit
// Chữ cố định của trang theo ngôn ngữ profile (data.lang). Nội dung người dùng nhập không dịch.
// levels: trình độ học vấn (education[].level), hiện làm tiêu đề khi không ghi ngành / bằng cấp.
const TEXT = {
  vi: {
    skills: 'Kỹ năng',
    projects: 'Dự án',
    experience: 'Kinh nghiệm',
    education: 'Học vấn',
    present: 'Hiện tại',
    yourName: 'Tên của bạn',
    phone: 'Điện thoại',
    source: 'Mã nguồn',
    contents: 'Mục lục',
    cardFront: 'Card visit, mặt trước',
    cardBack: 'Card visit, mặt sau',
    qr: 'Mã QR',
    levels: { th: 'Tiểu học', thcs: 'Trung học cơ sở', thpt: 'Trung học phổ thông', cd: 'Cao đẳng', dh: 'Đại học', sdh: 'Sau đại học' },
    loadError: 'Không tải được data.json. Hãy mở trang qua một web server (ví dụ GitHub Pages hoặc "npx serve"), không mở trực tiếp file.',
  },
  en: {
    skills: 'Skills',
    projects: 'Projects',
    experience: 'Experience',
    education: 'Education',
    present: 'Present',
    yourName: 'Your name',
    phone: 'Phone',
    source: 'Source code',
    contents: 'Contents',
    cardFront: 'Business card, front',
    cardBack: 'Business card, back',
    qr: 'QR code',
    levels: { th: 'Primary school', thcs: 'Lower secondary school', thpt: 'High school', cd: 'College', dh: 'University', sdh: 'Postgraduate' },
    loadError: 'Could not load data.json. Open this page through a web server (for example GitHub Pages or "npx serve"), not directly as a file.',
  },
};
let lang = 'vi';
let T = TEXT.vi;

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const list = (v) => (Array.isArray(v) ? v : []);

// Dữ liệu có thể đến từ người khác (link chia sẻ), nên chỉ cho phép các giao thức an toàn.
function safeHref(url) {
  let u = str(url);
  if (!u) return '';
  if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = 'https://' + u;
  try {
    return ['http:', 'https:'].includes(new URL(u).protocol) ? u : '';
  } catch {
    return '';
  }
}

function safeSrc(url) {
  const u = str(url);
  if (!u) return '';
  if (/^(data:image\/|blob:)/i.test(u)) return u;
  try {
    return ['http:', 'https:', 'file:'].includes(new URL(u, location.href).protocol) ? u : '';
  } catch {
    return '';
  }
}

// Tạo phần tử bằng DOM API (không dùng innerHTML) để chữ người dùng nhập không thành HTML.
function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if ((value === '' && key !== 'alt') || value == null || value === false) continue; // alt="": ảnh trang trí
    if (key === 'class') node.className = value;
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === '' || child == null || child === false) continue;
    node.append(child);
  }
  return node;
}

function link(href, text) {
  return el('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text);
}

const prettyUrl = (u) => u.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '');

// vi: 06/2023 · en: Jun 2023
function formatMonth(value) {
  const m = /^(\d{4})-(\d{2})$/.exec(str(value));
  if (!m) return str(value);
  if (lang !== 'en') return `${m[2]}/${m[1]}`;
  return new Date(Date.UTC(+m[1], +m[2] - 1)).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function period(start, end) {
  const s = formatMonth(start);
  const e = formatMonth(end) || (s ? T.present : '');
  return s ? `${s} – ${e}` : e;
}

function renderContact(contact) {
  const email = str(contact.email);
  const phone = str(contact.phone);
  const items = [
    ['Email', email && el('a', { href: `mailto:${email}` }, email)],
    [T.phone, phone && el('a', { href: `tel:${phone.replace(/[^\d+]/g, '')}` }, phone)],
    ...[
      ['Website', contact.website],
      ['GitHub', contact.github],
      ['LinkedIn', contact.linkedin],
    ].map(([label, url]) => [label, safeHref(url) && link(safeHref(url), prettyUrl(str(url)))]),
  ].filter(([, node]) => node);

  if (!items.length) return null;
  return el(
    'ul',
    { class: 'contact' },
    items.map(([label, node]) => el('li', {}, el('span', { class: 'contact__label' }, label), node))
  );
}

// --- Card visit (90×54 mm): mặt trước + mặt sau. Cỡ chữ theo % chiều rộng thẻ (cqw), in đúng khổ ở print.css ---
const textLines = (v) => str(v).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
const hexColor = (v) => (/^#[0-9a-f]{6}$/i.test(str(v)) ? str(v) : '');

// Mã QR vẽ bằng DOM (một <path> SVG), nền trắng để quét được với mọi màu thẻ. Không có thư viện → bỏ qua.
function renderQr(url) {
  const href = safeHref(url);
  if (!href || typeof qrcode !== 'function') return null;
  const qr = qrcode(0, 'M');
  qr.addData(href);
  qr.make();
  const n = qr.getModuleCount();
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `-2 -2 ${n + 4} ${n + 4}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `${T.qr}: ${prettyUrl(href)}`);
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', d);
  svg.append(path);
  return el('div', { class: 'bcard__qr' }, svg);
}

// Dòng đầu chữ lớn, các dòng sau chữ nhỏ. Bọc <span> để hiệu ứng highlight ôm theo chữ.
const cardText = (lines) =>
  el('div', { class: 'bcard__text' }, lines.map((line, i) => el('p', { class: i === 0 ? 'bcard__lead' : 'bcard__line' }, el('span', {}, line))));

function renderCards(profile, contact, card) {
  const c = card && typeof card === 'object' ? card : {};
  const front = textLines(c.front).length ? textLines(c.front) : [str(profile.fullName) || T.yourName, str(profile.title)].filter(Boolean);
  const auto = [
    str(contact.phone),
    str(contact.email),
    ...[contact.website, contact.github, contact.linkedin].map((u) => (safeHref(u) ? prettyUrl(str(u)) : '')),
    str(profile.location),
  ].filter(Boolean);
  const back = textLines(c.back).length ? textLines(c.back) : auto;
  const avatar = safeSrc(profile.avatar);
  const style = [hexColor(c.bg) && `--card-bg:${hexColor(c.bg)}`, hexColor(c.color) && `--card-fg:${hexColor(c.color)}`].filter(Boolean).join(';');
  const items = list(c.items).filter((it) => it && ITEM_TYPES.includes(it.type));
  // Kéo thả tự do: mỗi mặt là các phần tử đặt tuyệt đối. Không có thì tự sắp xếp.
  const face = (side, label, auto) =>
    items.length
      ? el('section', { class: `bcard bcard--${side} bcard--free`, 'aria-label': label }, items.filter((it) => (it.side === 'back' ? 'back' : 'front') === side).map((it) => renderItem(it, profile, c)))
      : el('section', { class: `bcard bcard--${side}`, 'aria-label': label }, ...auto);
  return el(
    'div',
    { class: 'cards', id: 'top', style, 'data-effect': CARD_EFFECTS.includes(c.effect) ? c.effect : 'none' },
    face('front', T.cardFront, [avatar && el('img', { class: 'bcard__avatar', src: avatar, alt: '' }), cardText(front)]),
    face('back', T.cardBack, [cardText(back), renderQr(c.qr)])
  );
}

// --- Card visit kéo thả tự do (card.items): x, y, w theo % thẻ; cỡ chữ theo cqw (% chiều rộng thẻ) ---
const ITEM_TYPES = ['text', 'image', 'avatar', 'qr'];
const num = (v, min, max, fallback) => (Number.isFinite(Number(v)) ? Math.min(max, Math.max(min, Number(v))) : fallback);

function renderItem(it, profile, card) {
  const style = [`left:${num(it.x, -50, 150, 0)}%`, `top:${num(it.y, -50, 150, 0)}%`, `width:${num(it.w, 1, 200, 30)}%`, `transform:rotate(${num(it.rot, -360, 360, 0)}deg)`];
  let content;
  if (it.type === 'text') {
    style.push(`font-size:${num(it.size, 1, 40, 5)}cqw`, `font-weight:${it.weight === 700 ? 700 : 300}`);
    if (hexColor(it.color)) style.push(`color:${hexColor(it.color)}`);
    content = el('span', {}, typeof it.text === 'string' && it.text ? it.text : ' ');
  } else if (it.type === 'qr') {
    content = renderQr(card.qr);
  } else {
    const src = safeSrc(it.type === 'avatar' ? profile.avatar : it.src);
    content = src && el('img', { src, alt: '' });
  }
  return el('div', { class: `bitem bitem--${it.type}`, 'data-id': str(it.id), style: style.join(';') }, content);
}

// Chụp bố cục tự động hiện tại thành các phần tử để kéo thả (generator gửi 'portfolio:card-freeze').
function measureCardItems() {
  const items = [];
  const id = () => Math.random().toString(36).slice(2, 10);
  const round = (n) => Math.round(n * 10) / 10;
  for (const card of app.querySelectorAll('.bcard')) {
    const side = card.classList.contains('bcard--back') ? 'back' : 'front';
    const box = card.getBoundingClientRect();
    const pos = (node) => {
      const r = node.getBoundingClientRect();
      return { x: round(((r.left - box.left) / box.width) * 100), y: round(((r.top - box.top) / box.height) * 100), w: round((r.width / box.width) * 100) };
    };
    const avatar = card.querySelector('.bcard__avatar');
    if (avatar) items.push({ id: id(), side, type: 'avatar', ...pos(avatar), rot: 0 });
    for (const p of card.querySelectorAll('.bcard__text p')) {
      const s = getComputedStyle(p);
      const text = p.textContent;
      items.push({ id: id(), side, type: 'text', text, ...pos(p), w: round(Math.min(100, (p.getBoundingClientRect().width / box.width) * 100 + 4)), rot: 0, size: round((parseFloat(s.fontSize) / box.width) * 100), weight: Number(s.fontWeight) >= 600 ? 700 : 300, color: '' });
    }
    const qr = card.querySelector('.bcard__qr');
    if (qr) items.push({ id: id(), side, type: 'qr', ...pos(qr), rot: 0 });
  }
  return items;
}

// Chỉnh card trong preview của generator: chọn, kéo, đổi cỡ (nút góc dưới), xoay (nút phía trên),
// phím mũi tên để nhích, Delete để xoá. Mỗi thay đổi gửi về generator ('portfolio:card-item').
let cardEdit = false;
let selectedId = '';
const tell = (message) => parent.postMessage(message, location.origin);

function markSelection() {
  app.querySelector('.cards')?.classList.toggle('is-editing', cardEdit);
  app.querySelectorAll('.bitem__handle').forEach((h) => h.remove());
  app.querySelectorAll('.bitem').forEach((n) => n.classList.toggle('is-selected', cardEdit && n.dataset.id === selectedId));
  const node = cardEdit && selectedId && app.querySelector(`.bitem[data-id="${CSS.escape(selectedId)}"]`);
  if (node) node.append(el('span', { class: 'bitem__handle bitem__handle--resize', 'data-handle': 'resize' }), el('span', { class: 'bitem__handle bitem__handle--rotate', 'data-handle': 'rotate' }));
}

function selectItem(id) {
  if (id === selectedId) return;
  selectedId = id;
  markSelection();
  tell({ type: 'portfolio:card-select', id });
}

function startCardDrag(event) {
  if (!cardEdit || event.button > 0) return;
  const node = event.target.closest('.bitem');
  if (!node) {
    if (event.target.closest('.bcard')) selectItem('');
    return;
  }
  event.preventDefault(); // không bôi đen chữ khi kéo…
  focus(); // …nhưng vẫn nhận phím (mũi tên, Delete) trong preview
  selectItem(node.dataset.id);
  const handle = event.target.dataset.handle || 'move';
  const card = node.closest('.bcard');
  const box = card.getBoundingClientRect();
  const r = node.getBoundingClientRect();
  const start = {
    px: event.clientX, py: event.clientY,
    x: parseFloat(node.style.left), y: parseFloat(node.style.top), w: parseFloat(node.style.width),
    size: parseFloat(node.style.fontSize) || 0,
    cx: r.left + r.width / 2, cy: r.top + r.height / 2,
  };
  const wPct = (node.offsetWidth / box.width) * 100;
  const hPct = (node.offsetHeight / box.height) * 100;
  const guides = [el('span', { class: 'bguide bguide--x', hidden: true }), el('span', { class: 'bguide bguide--y', hidden: true })];
  card.append(...guides);
  const round = (n) => Math.round(n * 10) / 10;
  const patch = {};
  const move = (e) => {
    const dx = ((e.clientX - start.px) / box.width) * 100;
    const dy = ((e.clientY - start.py) / box.height) * 100;
    if (handle === 'move') {
      let x = start.x + dx;
      let y = start.y + dy;
      const snapX = Math.abs(x + wPct / 2 - 50) < 1.5; // canh giữa thẻ
      const snapY = Math.abs(y + hPct / 2 - 50) < 2.5;
      if (snapX) x = 50 - wPct / 2;
      if (snapY) y = 50 - hPct / 2;
      guides[0].hidden = !snapX;
      guides[1].hidden = !snapY;
      node.style.left = `${x}%`;
      node.style.top = `${y}%`;
      Object.assign(patch, { x: round(x), y: round(y) });
    } else if (handle === 'resize') {
      const w = Math.max(3, start.w + dx);
      node.style.width = `${w}%`;
      patch.w = round(w);
      if (start.size) {
        node.style.fontSize = `${(start.size * w) / start.w}cqw`;
        patch.size = round((start.size * w) / start.w);
      }
    } else {
      let rot = Math.round((Math.atan2(e.clientY - start.cy, e.clientX - start.cx) * 180) / Math.PI + 90);
      if (rot > 180) rot -= 360;
      for (const s of [0, 90, -90, 180, -180]) if (Math.abs(rot - s) < 5) rot = s; // hít vào góc vuông
      node.style.transform = `rotate(${rot}deg)`;
      patch.rot = rot;
    }
  };
  const up = () => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
    guides.forEach((g) => g.remove());
    if (Object.keys(patch).length) tell({ type: 'portfolio:card-item', id: node.dataset.id, patch });
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
}

function cardKeys(event) {
  if (!cardEdit || !selectedId) return;
  const node = app.querySelector(`.bitem[data-id="${CSS.escape(selectedId)}"]`);
  if (!node) return;
  if (event.key === 'Delete' || event.key === 'Backspace') {
    event.preventDefault();
    tell({ type: 'portfolio:card-delete', id: selectedId });
    return;
  }
  const step = event.shiftKey ? 2 : 0.5;
  const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
  if (!d) return;
  event.preventDefault();
  const x = Math.round((parseFloat(node.style.left) + d[0]) * 10) / 10;
  const y = Math.round((parseFloat(node.style.top) + d[1]) * 10) / 10;
  node.style.left = `${x}%`;
  node.style.top = `${y}%`;
  tell({ type: 'portfolio:card-item', id: selectedId, patch: { x, y } });
}

function renderHero(profile, contact) {
  const avatar = safeSrc(profile.avatar);
  return el(
    'header',
    { class: 'hero container', id: 'top' },
    avatar && el('img', { class: 'hero__avatar reveal', src: avatar, alt: str(profile.fullName) }),
    el(
      'div',
      { class: 'hero__text reveal', style: '--i:1' },
      el('h1', {}, str(profile.fullName) || T.yourName),
      str(profile.title) && el('p', { class: 'hero__title' }, str(profile.title)),
      str(profile.location) && el('p', { class: 'hero__location' }, str(profile.location)),
      str(profile.bio) && el('p', { class: 'hero__bio' }, str(profile.bio)),
      renderContact(contact)
    )
  );
}

// Bìa kiểu tạp chí: ảnh lớn + khối màu chứa tên chữ hoa, mỗi chữ một dòng.
// Ảnh: ảnh bìa → ảnh dự án đầu tiên → ảnh đại diện.
function renderCover(profile, projects) {
  const photo = [profile.cover, ...list(projects).map((p) => p?.image), profile.avatar].map(safeSrc).find(Boolean);
  const words = (str(profile.fullName) || T.yourName).split(/\s+/);
  return el(
    'div', // chỉ để trang trí: mọi thông tin trên bìa đã có ở trang giới thiệu (header chính)
    { class: 'cover', id: 'top', 'aria-hidden': 'true' },
    el('p', { class: 'cover__corner' }, `Profile / ${new Date().getFullYear()}`),
    el('p', { class: 'cover__corner cover__corner--end' }, str(profile.location)),
    el('div', { class: 'cover__photo' }, photo && el('img', { src: photo, alt: '' })),
    el(
      'div',
      { class: 'cover__block reveal' },
      str(profile.title) && el('p', { class: 'cover__tag' }, str(profile.title)),
      // Tên đã có trong h1 ở trang giới thiệu, ở đây chỉ để trang trí.
      el('p', { class: 'cover__name', 'aria-hidden': 'true' }, words.map((w) => el('span', {}, w))),
      el('p', { class: 'cover__meta' }, `Personal Profile / ${new Date().getFullYear()}`)
    )
  );
}

// Trang "Mục lục": số thứ tự + tên section, bấm để tới section đó.
function renderIndex(sections) {
  return el(
    'nav',
    { class: 'page mag-index reveal', 'aria-label': T.contents },
    el('h2', { class: 'mag-index__title' }, `${T.contents}.`),
    el(
      'ol',
      {},
      sections.map(([id, title], i) =>
        el('li', {}, el('a', { href: `#${id}` }, el('span', {}, `${String(i + 1).padStart(2, '0')}.`), el('em', {}, title)))
      )
    )
  );
}

function renderSkills(skills) {
  const groups = list(skills)
    .map((g) => ({ group: str(g?.group), items: list(g?.items).map(str).filter(Boolean) }))
    .filter((g) => g.items.length);
  if (!groups.length) return null;
  return el(
    'div',
    { class: 'skills' },
    groups.map((g, i) =>
      el(
        'div',
        { class: 'skill-group reveal', style: `--i:${i % 3}` },
        g.group && el('h3', {}, g.group),
        el('ul', { class: 'tags' }, g.items.map((item) => el('li', {}, item)))
      )
    )
  );
}

function renderProjects(projects) {
  const items = list(projects).filter((p) => str(p?.name) || str(p?.description));
  if (!items.length) return null;
  return el(
    'div',
    { class: 'projects' },
    items.map((p, i) => {
      const image = safeSrc(p.image);
      const tech = list(p.tech).map(str).filter(Boolean);
      const demo = safeHref(p.demoUrl);
      const repo = safeHref(p.repoUrl);
      return el(
        'article',
        { class: 'card reveal', style: `--i:${i % 3}` },
        image && el('img', { class: 'card__img', src: image, alt: str(p.name), loading: 'lazy' }),
        el(
          'div',
          { class: 'card__body' },
          str(p.name) && el('h3', {}, str(p.name)),
          str(p.description) && el('p', {}, str(p.description)),
          tech.length > 0 && el('ul', { class: 'tags' }, tech.map((t) => el('li', {}, t))),
          (demo || repo) &&
            el('div', { class: 'card__links' }, demo && link(demo, 'Demo'), repo && link(repo, T.source))
        )
      );
    })
  );
}

function renderTimeline(entries, toItem) {
  const items = list(entries).map(toItem).filter((it) => it.heading || it.org);
  if (!items.length) return null;
  return el(
    'ol',
    { class: 'timeline' },
    items.map((it) =>
      el(
        'li',
        { class: 'timeline__item reveal' },
        el('div', { class: 'timeline__period' }, it.period),
        el(
          'div',
          {},
          it.heading && el('h3', {}, it.heading),
          it.org && el('p', { class: 'timeline__org' }, it.org),
          it.description && el('p', { class: 'timeline__desc' }, it.description)
        )
      )
    )
  );
}

function render(data) {
  const d = data && typeof data === 'object' ? data : {};
  const profile = d.profile || {};
  const contact = d.contact || {};
  const fullName = str(profile.fullName);
  lang = d.lang === 'en' ? 'en' : 'vi';
  T = TEXT[lang];
  document.documentElement.lang = lang;

  const sections = [
    ['skills', T.skills, renderSkills(d.skills)],
    ['projects', T.projects, renderProjects(d.projects)],
    [
      'experience',
      T.experience,
      renderTimeline(d.experience, (x) => ({
        heading: str(x?.role),
        org: str(x?.company),
        period: period(x?.start, x?.end),
        description: str(x?.description),
      })),
    ],
    [
      'education',
      T.education,
      renderTimeline(d.education, (x) => ({
        heading: str(x?.degree) || T.levels[str(x?.level)] || '',
        org: str(x?.school),
        period: period(x?.start, x?.end),
      })),
    ],
  ].filter(([, , content]) => content);

  document.title = fullName
    ? [fullName, str(profile.title)].filter(Boolean).join(' — ')
    : 'Profile';
  document.documentElement.dataset.theme = THEMES.includes(d.theme) ? d.theme : 'minimal';
  const layout = LAYOUTS.includes(d.layout) ? d.layout : 'classic';
  document.documentElement.dataset.layout = layout;

  const nav = el(
    'nav',
    { class: 'nav' },
    el(
      'div',
      { class: 'nav__inner container' },
      el('a', { class: 'nav__brand', href: '#top' }, 'Personal Profile'),
      sections.length > 0 &&
        el(
          'div',
          { class: 'nav__scroller' },
          el(
            'ul',
            { class: 'nav__tabs' },
            el('li', { class: 'nav__indicator', 'aria-hidden': 'true' }),
            sections.map(([id, title]) => el('li', {}, el('a', { class: 'nav__tab', href: `#${id}` }, title)))
          )
        )
    )
  );
  const hero = renderHero(profile, contact);
  const main = el(
    'main',
    {},
    sections.map(([id, title, content]) =>
      el(
        'section',
        { class: 'section container', id },
        el('h2', { class: 'section__title reveal' }, title),
        content
      )
    )
  );
  const footer = el('footer', { class: 'footer container' }, `© ${new Date().getFullYear()} ${fullName}`.trim());

  // Sidebar: cột trái (tiêu đề, giới thiệu, thẻ điều hướng dọc) + cột phải cuộn nội dung.
  // Tạp chí: bìa → thanh thẻ → hai trang "Mục lục" + giới thiệu đặt cạnh nhau → các section.
  // Các bố cục khác chỉ khác nhau ở CSS (style.css, html[data-layout]).
  if (layout === 'magazine') {
    hero.removeAttribute('id'); // #top là bìa
    hero.classList.add('page');
  }
  app.replaceChildren(
    ...(layout === 'card'
      ? [renderCards(profile, contact, d.card)]
      : layout === 'sidebar'
      ? [
          el(
            'div',
            { class: 'shell' },
            el('aside', { class: 'side' }, el('p', { class: 'side__brand container' }, 'Personal Profile'), hero, nav),
            el('div', { class: 'content' }, main, footer)
          ),
        ]
      : layout === 'magazine'
        ? [
            renderCover(profile, d.projects),
            nav,
            el('div', { class: 'spread container' }, sections.length > 0 && renderIndex(sections), hero),
            main,
            footer,
          ]
        : [nav, hero, main, footer])
  );

  // Lần đầu: hiện dần khi cuộn tới. Các lần sau (preview cập nhật khi gõ): hiện ngay.
  if (layout === 'card') markSelection();
  reveal(hasRendered);
  hasRendered = true;
  activeTab = null;
  updateActiveTab();
  if (pendingScroll) scrollToSection(pendingScroll);
}

// Thẻ của section đang xem được highlight; khối highlight trượt theo khi cuộn.
function updateActiveTab() {
  const tabs = [...app.querySelectorAll('.nav__tab')];
  if (!tabs.length) return;
  const sectionsInPage = tabs.map((tab) => document.getElementById(tab.hash.slice(1)));
  // Thanh điều hướng dính trên đầu che mất một phần trang; bố cục không có (Sidebar desktop) đặt --nav-h: 0.
  const navOnTop = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--nav-h')) > 0;
  const navHeight = navOnTop ? app.querySelector('.nav').offsetHeight : 0;
  const line = navHeight + innerHeight * 0.3; // section có đầu đã qua vạch này là section đang xem

  // Section đã qua vạch và nằm gần vạch nhất (không dựa vào thứ tự trong HTML).
  let index = -1;
  let best = -Infinity;
  sectionsInPage.forEach((section, i) => {
    const top = section.getBoundingClientRect().top;
    if (top <= line && top > best) {
      best = top;
      index = i;
    }
  });
  // Cuộn tới đáy trang thì section cuối luôn được chọn (có thể quá ngắn để chạm vạch).
  if (innerHeight + scrollY >= document.documentElement.scrollHeight - 2) index = tabs.length - 1;

  const tab = tabs[index] || null;
  if (tab === activeTab) return;
  activeTab = tab;
  tabs.forEach((t) => (t === tab ? t.setAttribute('aria-current', 'true') : t.removeAttribute('aria-current')));
  moveIndicator();
}

function moveIndicator() {
  const indicator = app.querySelector('.nav__indicator');
  if (!indicator) return;
  indicator.classList.toggle('is-visible', Boolean(activeTab));
  const scroller = app.querySelector('.nav__scroller');
  if (!activeTab) {
    scroller.scrollTo({ left: 0, behavior: canAnimate ? 'smooth' : 'auto' });
    return;
  }
  // Thẻ xếp ngang (thanh trên cùng) hoặc dọc (Sidebar): đặt đúng vị trí và kích thước cả hai chiều.
  indicator.style.width = `${activeTab.offsetWidth}px`;
  indicator.style.height = `${activeTab.offsetHeight}px`;
  indicator.style.transform = `translate(${activeTab.offsetLeft}px, ${activeTab.offsetTop}px)`;
  // Trên điện thoại thanh thẻ cuộn ngang: kéo thẻ đang chọn vào giữa.
  scroller.scrollTo({
    left: activeTab.offsetLeft - (scroller.clientWidth - activeTab.offsetWidth) / 2,
    behavior: canAnimate ? 'smooth' : 'auto',
  });
}

let scrollQueued = false;
addEventListener(
  'scroll',
  () => {
    if (scrollQueued) return;
    scrollQueued = true;
    requestAnimationFrame(() => {
      scrollQueued = false;
      updateActiveTab();
    });
  },
  { passive: true }
);
addEventListener('resize', () => {
  moveIndicator();
  updateActiveTab();
});
document.fonts?.ready.then(moveIndicator); // độ rộng thẻ đổi khi font web tải xong

function scrollToSection(id) {
  // Đầu trang: cuộn hẳn về 0, không thì thanh menu dính (sticky) che mất tên trên điện thoại.
  if (id === 'top') {
    pendingScroll = '';
    scrollTo({ top: 0, behavior: canAnimate ? 'smooth' : 'auto' });
    return;
  }
  const node = document.getElementById(id);
  pendingScroll = node ? '' : id;
  node?.scrollIntoView({ behavior: canAnimate ? 'smooth' : 'auto' });
}

function reveal(instant) {
  observer?.disconnect();
  const items = app.querySelectorAll('.reveal');
  if (!canAnimate || instant) {
    items.forEach((node) => node.classList.add('is-visible'));
    return;
  }
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      }
    },
    { threshold: 0.15, rootMargin: '0px 0px -8% 0px' }
  );
  items.forEach((node) => observer.observe(node));
}

async function fetchJson(file) {
  const res = await fetch(file, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${res.status} ${file}`);
  return res.json();
}

// Thử lần lượt: data.json (web server) → dữ liệu nhúng trong index.html khi xuất ZIP
// (mở bằng file:// không fetch được) → data.sample.json (thư mục template gốc).
async function loadData() {
  const sources = [
    () => fetchJson('data.json'),
    () => JSON.parse(document.getElementById('portfolio-data').textContent),
    () => fetchJson('data.sample.json'),
  ];
  for (const source of sources) {
    try {
      return await source();
    } catch {
      // Thử nguồn tiếp theo.
    }
  }
  throw new Error('Không đọc được data.json');
}

// Chưa có data nên chưa biết ngôn ngữ profile: theo <html lang> (ZIP tiếng Anh đặt sẵn "en").
function showError() {
  const text = TEXT[document.documentElement.lang === 'en' ? 'en' : 'vi'].loadError;
  app.replaceChildren(el('p', { class: 'container notice' }, text));
}

if (canAnimate) document.documentElement.classList.add('anim');

if (isPreview) {
  addEventListener('message', (event) => {
    if (event.source !== parent || event.origin !== location.origin) return;
    if (event.data?.type === 'portfolio:ping') parent.postMessage({ type: 'portfolio:ready' }, location.origin);
    if (event.data?.type === 'portfolio:data') render(event.data.data);
    if (event.data?.type === 'portfolio:scroll') scrollToSection(event.data.id);
    if (event.data?.type === 'portfolio:card-edit') {
      cardEdit = Boolean(event.data.on);
      if ('selected' in event.data) selectedId = event.data.selected || '';
      markSelection();
    }
    if (event.data?.type === 'portfolio:card-freeze') tell({ type: 'portfolio:card-items', items: measureCardItems() });
  });
  addEventListener('pointerdown', startCardDrag);
  addEventListener('keydown', cardKeys);
  parent.postMessage({ type: 'portfolio:ready' }, location.origin);
} else {
  loadData().then(render, showError);
}
