/* ============================================================
   PONTO BIOMÉTRICO FACIAL — app.js
   Reconhecimento facial real (face-api.js / TensorFlow.js), 100%
   client-side. Nenhuma imagem sai do tablet, exceto se você
   configurar AWS_SYNC_ENDPOINT em config.js.
   ============================================================ */

// ---------- Elementos ----------
const video = document.getElementById('video');
const overlayCanvas = document.getElementById('overlayCanvas');
const cameraBox = document.getElementById('cameraBox');
const scannerCircle = document.getElementById('scannerCircle');
const matchContainer = document.getElementById('matchContainer');
const matchImg = document.getElementById('matchImg');
const matchName = document.getElementById('matchName');
const matchStatus = document.getElementById('matchStatus');
const captureFlash = document.getElementById('captureFlash');
const loadingOverlay = document.getElementById('loadingOverlay');
const loadingSub = document.getElementById('loadingSub');
const admTrigger = document.getElementById('admTrigger');

// ---------- Estado ----------
let db = null;
let colaboradores = [];               // { id, nome, foto, departamento, turno, descriptor, dataCadastro }
let faceMatcher = null;
let cfg = null;
let turnos = [];
let stream = null;
let modelsReady = false;
let detectLoopHandle = null;

let ultimoRegistroPorMatricula = {};  // cache em memória + localStorage
let lastDetectedLabel = null;
let lastFaceSeenAt = 0;
let earHistory = [];
let livenessConfirmedUntil = 0;
let lastEyesOpen = true;
let uiLockUntil = 0;                  // evita repetir toasts/estado rapidamente

let pendingDescriptors = [];          // amostras capturadas no cadastro (admin)
let sessionAdminUnlocked = false;

const EAR_CLOSED = 0.22;
const EAR_OPEN = 0.27;
const DETECT_INTERVAL_MS = 550;

// ============================================================
// UTILITÁRIOS
// ============================================================
function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function localDateKey(d = new Date()) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatDateTimeBR(d = new Date()) {
  return d.toLocaleString('pt-BR');
}

function showToast(message, type = 'success') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message; // textContent -> sem risco de XSS
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(100px)';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

function tocarSom(tipo) {
  if (!cfg) return;
  if (tipo === 'registro' && !cfg.somRegistro) return;
  if (tipo === 'cadastrado' && !cfg.somCadastro) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    const freq = tipo === 'registro' ? 880 : (tipo === 'cadastrado' ? 660 : 440);
    const dur = 0.4;
    osc.frequency.value = freq; osc.type = 'sine';
    gain.gain.value = 0.8;
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + dur);
    if (navigator.vibrate) setTimeout(() => navigator.vibrate(120), 80);
  } catch (e) { /* som indisponível, ignora silenciosamente */ }
}

// ============================================================
// RELÓGIO
// ============================================================
setInterval(() => { document.getElementById('clock').textContent = new Date().toLocaleTimeString('pt-BR'); }, 1000);
document.getElementById('footerYear').textContent = '© ' + new Date().getFullYear();

// ============================================================
// MENU / NAVEGAÇÃO
// ============================================================
function toggleMenu() { document.getElementById('menuDropdown').classList.toggle('open'); }
function closeMenu() { document.getElementById('menuDropdown').classList.remove('open'); }
document.addEventListener('click', (e) => {
  const menu = document.querySelector('.menu-hamburger');
  if (!menu.contains(e.target)) closeMenu();
});

function handleMenuClick(section) {
  document.querySelectorAll('.section-hidden').forEach(el => el.classList.remove('open'));
  const sections = { config: document.getElementById('configSection'), admin: document.getElementById('adminSection'), pdf: document.getElementById('pdfSection') };
  document.getElementById('mainSection').style.display = (section === 'main') ? 'block' : 'none';
  if (sections[section]) sections[section].classList.add('open');

  document.querySelectorAll('.menu-dropdown .item').forEach(item => item.classList.toggle('active', item.dataset.section === section));

  if (section === 'config') { preencherFormConfig(); }
  if (section === 'admin') {
    if (sessionAdminUnlocked) { mostrarPainelAdmin(); } else { mostrarLoginAdmin(); }
  }
  if (section === 'pdf') {
    const hoje = localDateKey();
    if (!document.getElementById('relDataIni').value) document.getElementById('relDataIni').value = hoje;
    if (!document.getElementById('relDataFim').value) document.getElementById('relDataFim').value = hoje;
  }
  closeMenu();
}

admTrigger.addEventListener('click', () => handleMenuClick('admin'));

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { handleMenuClick('main'); closeMenu(); }
});

// ============================================================
// CONFIGURAÇÕES (localStorage)
// ============================================================
function carregarConfig() {
  try {
    const raw = localStorage.getItem('pontoConfig');
    cfg = raw ? { ...DEFAULT_CONFIG, ...JSON.parse(raw) } : { ...DEFAULT_CONFIG };
  } catch { cfg = { ...DEFAULT_CONFIG }; }

  try {
    const rawT = localStorage.getItem('pontoTurnos');
    turnos = rawT ? JSON.parse(rawT) : JSON.parse(JSON.stringify(DEFAULT_TURNOS));
  } catch { turnos = JSON.parse(JSON.stringify(DEFAULT_TURNOS)); }

  try {
    const rawU = localStorage.getItem('ultimoRegistroPorMatricula');
    ultimoRegistroPorMatricula = rawU ? JSON.parse(rawU) : {};
  } catch { ultimoRegistroPorMatricula = {}; }

  document.getElementById('empresaNomeHeader').textContent = cfg.empresaNome || 'Ponto Seguro';
  document.title = (cfg.empresaNome || 'Ponto Seguro') + ' — Ponto Biométrico';
}

function preencherFormConfig() {
  document.getElementById('cfgEmpresaNome').value = cfg.empresaNome || '';
  document.getElementById('toggleSomRegistro').classList.toggle('active', !!cfg.somRegistro);
  document.getElementById('toggleSomCadastro').classList.toggle('active', !!cfg.somCadastro);
  document.getElementById('toggleLiveness').classList.toggle('active', !!cfg.exigirLiveness);
  document.getElementById('intervaloRegistro').value = String(cfg.intervaloRegistroMin);
  document.getElementById('limiarReconhecimento').value = String(cfg.limiarReconhecimento);
  renderTurnosConfig();
}

function toggleConfigSwitch(el, chave) {
  el.classList.toggle('active');
  cfg[chave] = el.classList.contains('active');
}

function salvarConfiguracoes() {
  cfg.empresaNome = document.getElementById('cfgEmpresaNome').value.trim() || 'Ponto Seguro';
  cfg.intervaloRegistroMin = parseInt(document.getElementById('intervaloRegistro').value, 10);
  cfg.limiarReconhecimento = parseFloat(document.getElementById('limiarReconhecimento').value);
  localStorage.setItem('pontoConfig', JSON.stringify(cfg));
  document.getElementById('empresaNomeHeader').textContent = cfg.empresaNome;
  document.title = cfg.empresaNome + ' — Ponto Biométrico';
  showToast('✅ Configurações salvas', 'success');
}

function renderTurnosConfig() {
  const wrap = document.getElementById('turnosConfigWrap');
  wrap.innerHTML = '';
  turnos.forEach((t, idx) => {
    const card = document.createElement('div');
    card.className = 'turno-card';
    card.innerHTML = `
      <div class="turno-title">🚌 ${esc(t.nome)}</div>
      <div class="input-group"><label>Nome do turno</label><input type="text" data-idx="${idx}" data-f="nome" value="${esc(t.nome)}"></div>
      <div class="turno-grid">
        <div class="input-group"><label>Entrada</label><input type="time" data-idx="${idx}" data-f="entrada" value="${esc(t.entrada)}"></div>
        <div class="input-group"><label>Saída</label><input type="time" data-idx="${idx}" data-f="saida" value="${esc(t.saida)}"></div>
        <div class="input-group"><label>Início intervalo</label><input type="time" data-idx="${idx}" data-f="intervaloInicio" value="${esc(t.intervaloInicio)}"></div>
        <div class="input-group"><label>Fim intervalo</label><input type="time" data-idx="${idx}" data-f="intervaloFim" value="${esc(t.intervaloFim)}"></div>
      </div>`;
    wrap.appendChild(card);
  });
  // popula também o select de turno no cadastro de colaborador
  const sel = document.getElementById('newTurno');
  sel.innerHTML = turnos.map(t => `<option value="${t.id}">${esc(t.nome)}</option>`).join('');
}

function salvarTurnos() {
  document.querySelectorAll('#turnosConfigWrap input').forEach(inp => {
    const idx = parseInt(inp.dataset.idx, 10);
    const campo = inp.dataset.f;
    turnos[idx][campo] = inp.value;
  });
  localStorage.setItem('pontoTurnos', JSON.stringify(turnos));
  renderTurnosConfig();
  showToast('✅ Turnos salvos', 'success');
}

// ============================================================
// ADMIN — PIN
// ============================================================
function mostrarLoginAdmin() {
  document.getElementById('adminLoginBox').style.display = 'block';
  document.getElementById('adminPanelBox').style.display = 'none';
  document.getElementById('adminPinInput').value = '';
  document.getElementById('pinFirstRunHint').style.display = cfg.adminPinHash ? 'none' : 'block';
}

function mostrarPainelAdmin() {
  document.getElementById('adminLoginBox').style.display = 'none';
  document.getElementById('adminPanelBox').style.display = 'block';
  carregarColaboradores();
  carregarHistorico();
}

async function tentarLoginAdmin() {
  const pin = document.getElementById('adminPinInput').value.trim();
  if (pin.length < 4) { showToast('⚠️ O PIN deve ter ao menos 4 dígitos', 'error'); return; }
  const hash = await sha256Hex(pin);
  if (!cfg.adminPinHash) {
    cfg.adminPinHash = hash;
    localStorage.setItem('pontoConfig', JSON.stringify(cfg));
    showToast('🔐 PIN definido! Guarde-o em local seguro.', 'success');
    sessionAdminUnlocked = true;
    mostrarPainelAdmin();
    return;
  }
  if (hash === cfg.adminPinHash) {
    sessionAdminUnlocked = true;
    mostrarPainelAdmin();
  } else {
    showToast('❌ PIN incorreto', 'error');
  }
}

function sairAdmin() {
  sessionAdminUnlocked = false;
  handleMenuClick('main');
}

// ============================================================
// INDEXEDDB
// ============================================================
function abrirBanco() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('PontoBiometricoDB', 4);

    request.onupgradeneeded = (e) => {
      const _db = e.target.result;
      let colabStore;
      if (!_db.objectStoreNames.contains('colaboradores')) {
        colabStore = _db.createObjectStore('colaboradores', { keyPath: 'id' });
        colabStore.createIndex('nome', 'nome', { unique: false });
      }
      let pontosStore;
      if (!_db.objectStoreNames.contains('pontos')) {
        pontosStore = _db.createObjectStore('pontos', { keyPath: 'pontoId', autoIncrement: true });
      } else {
        pontosStore = e.currentTarget.transaction.objectStore('pontos');
      }
      if (!pontosStore.indexNames.contains('matricula')) pontosStore.createIndex('matricula', 'matricula', { unique: false });
      if (!pontosStore.indexNames.contains('dataKey')) pontosStore.createIndex('dataKey', 'dataKey', { unique: false });
    };

    request.onsuccess = (e) => resolve(e.target.result);
    request.onerror = () => reject(request.error);
  });
}

// ============================================================
// CÂMERA
// ============================================================
async function iniciarCamera() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }
    });
    video.srcObject = stream;
    await new Promise(resolve => { video.onloadedmetadata = () => { video.play(); resolve(); }; });
    cameraBox.classList.add('active');
    overlayCanvas.width = video.videoWidth;
    overlayCanvas.height = video.videoHeight;
  } catch (err) {
    console.error('Erro na câmera:', err);
    showToast('⚠️ Permita o acesso à câmera nas configurações do navegador e recarregue a página', 'error');
    throw err;
  }
}

// ============================================================
// FACE-API — CARREGAMENTO DOS MODELOS
// ============================================================
async function carregarModelos() {
  loadingSub.textContent = 'Baixando rede neural de detecção facial...';
  await faceapi.nets.tinyFaceDetector.loadFromUri(FACE_MODELS_URL);
  loadingSub.textContent = 'Baixando modelo de pontos faciais (landmarks)...';
  await faceapi.nets.faceLandmark68Net.loadFromUri(FACE_MODELS_URL);
  loadingSub.textContent = 'Baixando modelo de reconhecimento facial...';
  await faceapi.nets.faceRecognitionNet.loadFromUri(FACE_MODELS_URL);
  modelsReady = true;
}

function construirFaceMatcher() {
  const validos = colaboradores.filter(c => c.descriptor && c.descriptor.length === 128);
  if (validos.length === 0) { faceMatcher = null; return; }
  const labeled = validos.map(c => new faceapi.LabeledFaceDescriptors(c.id, [Float32Array.from(c.descriptor)]));
  faceMatcher = new faceapi.FaceMatcher(labeled, cfg.limiarReconhecimento);
}

// ---------- Eye Aspect Ratio (prova de vida por piscar) ----------
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function earFromEye(eye) {
  // eye = 6 pontos (formato dlib/face-api getLeftEye()/getRightEye())
  const a = dist(eye[1], eye[5]);
  const b = dist(eye[2], eye[4]);
  const c = dist(eye[0], eye[3]);
  return (a + b) / (2 * c);
}

function registrarBlinkFrame(landmarks) {
  const ear = (earFromEye(landmarks.getLeftEye()) + earFromEye(landmarks.getRightEye())) / 2;
  const now = Date.now();
  earHistory.push({ ear, t: now });
  earHistory = earHistory.filter(h => now - h.t < 4000);

  const eyesOpenNow = ear > EAR_OPEN;
  const eyesClosedNow = ear < EAR_CLOSED;
  if (lastEyesOpen && eyesClosedNow) lastEyesOpen = false;
  else if (!lastEyesOpen && eyesOpenNow) {
    lastEyesOpen = true;
    livenessConfirmedUntil = now + 8000; // piscada detectada: válido por 8s
  }
}

function resetLivenessSession() {
  earHistory = [];
  lastEyesOpen = true;
  livenessConfirmedUntil = 0;
}

// ============================================================
// LOOP DE DETECÇÃO / RECONHECIMENTO AUTOMÁTICO
// ============================================================
function iniciarLoopDeteccao() {
  const opts = new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 });
  detectLoopHandle = setInterval(async () => {
    if (!modelsReady || video.paused || video.readyState < 2) return;
    try {
      const result = await faceapi.detectSingleFace(video, opts).withFaceLandmarks().withFaceDescriptor();
      const ctx = overlayCanvas.getContext('2d');
      ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

      if (!result) {
        if (Date.now() - lastFaceSeenAt > 1500) {
          lastDetectedLabel = null;
          resetLivenessSession();
          setStatusProcurando();
        }
        return;
      }

      lastFaceSeenAt = Date.now();
      cameraBox.classList.add('detecting');

      // desenha um retângulo simples ao redor do rosto detectado
      const box = result.detection.box;
      ctx.strokeStyle = '#10b981';
      ctx.lineWidth = 2;
      ctx.strokeRect(box.x, box.y, box.width, box.height);

      if (colaboradores.length === 0 || !faceMatcher) {
        setStatusNaoCadastrado();
        return;
      }

      const bestMatch = faceMatcher.findBestMatch(result.descriptor);
      const label = bestMatch.label; // matrícula ou 'unknown'

      if (label !== lastDetectedLabel) {
        lastDetectedLabel = label;
        resetLivenessSession();
      }
      registrarBlinkFrame(result.landmarks);

      if (label === 'unknown') {
        setStatusNaoCadastrado();
        return;
      }

      const colaborador = colaboradores.find(c => c.id === label);
      if (!colaborador) { setStatusNaoCadastrado(); return; }

      const livenessOk = !cfg.exigirLiveness || Date.now() < livenessConfirmedUntil;

      if (!livenessOk) {
        setStatusAguardandoPiscar(colaborador);
        return;
      }

      await tentarRegistrarPonto(colaborador, bestMatch.distance);

    } catch (err) {
      console.error('Erro na detecção:', err);
    }
  }, DETECT_INTERVAL_MS);
}

function setStatusProcurando() {
  cameraBox.classList.remove('detecting');
  scannerCircle.classList.remove('locked');
  if (Date.now() < uiLockUntil) return;
  matchContainer.className = 'match-container waiting';
  matchName.className = 'match-name';
  matchName.textContent = 'Aguardando...';
  matchStatus.innerHTML = '<span class="dot dot-gray"></span>Posicione o rosto na câmera';
}

function setStatusNaoCadastrado() {
  if (Date.now() < uiLockUntil) return;
  matchContainer.className = 'match-container searching';
  matchName.className = 'match-name';
  matchName.textContent = 'Rosto não reconhecido';
  matchStatus.innerHTML = '<span class="dot dot-amber"></span>Colaborador não cadastrado no sistema';
}

function setStatusAguardandoPiscar(colaborador) {
  matchContainer.className = 'match-container searching';
  matchName.className = 'match-name';
  matchName.textContent = esc(colaborador.nome);
  matchStatus.innerHTML = '<span class="dot dot-blue"></span>😉 Pisque os olhos para confirmar que é você';
}

// ============================================================
// REGISTRO AUTOMÁTICO DE PONTO
// ============================================================
function podeRegistrar(matricula) {
  const ultimo = ultimoRegistroPorMatricula[matricula] || 0;
  const diffMin = (Date.now() - ultimo) / 60000;
  if (diffMin < cfg.intervaloRegistroMin) return { pode: false, restanteMin: Math.ceil(cfg.intervaloRegistroMin - diffMin) };
  return { pode: true };
}

async function getRegistrosHoje(matricula) {
  return new Promise((resolve) => {
    const tx = db.transaction(['pontos'], 'readonly');
    const idx = tx.objectStore('pontos').index('matricula');
    const req = idx.getAll(matricula);
    req.onsuccess = () => {
      const hoje = localDateKey();
      resolve((req.result || []).filter(r => r.dataKey === hoje));
    };
    req.onerror = () => resolve([]);
  });
}

function capturarFotoDoVideo(size = 320) {
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = Math.round(size * 0.75);
  const ctx = canvas.getContext('2d');
  // espelha para ficar consistente com a pré-visualização da câmera
  ctx.translate(canvas.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.8);
}

async function tentarRegistrarPonto(colaborador, distancia) {
  const chk = podeRegistrar(colaborador.id);
  if (!chk.pode) {
    if (Date.now() >= uiLockUntil) {
      matchContainer.className = 'match-container searching';
      matchName.className = 'match-name';
      matchName.textContent = esc(colaborador.nome);
      matchStatus.innerHTML = `<span class="dot dot-amber"></span>Já registrado. Aguarde ${chk.restanteMin} min para bater novamente`;
      uiLockUntil = Date.now() + 3000;
    }
    return;
  }

  const registrosHoje = await getRegistrosHoje(colaborador.id);
  const tipo = TIPOS_BATIDA[registrosHoje.length % 4];
  const agora = new Date();
  const foto = capturarFotoDoVideo();

  const registro = {
    matricula: colaborador.id,
    nome: colaborador.nome,
    tipo,
    turno: colaborador.turno,
    departamento: colaborador.departamento,
    foto,
    horarioISO: agora.toISOString(),
    horario: formatDateTimeBR(agora),
    dataKey: localDateKey(agora),
    distancia: Number(distancia.toFixed(3))
  };

  const tx = db.transaction(['pontos'], 'readwrite');
  tx.objectStore('pontos').add(registro);
  tx.oncomplete = () => {
    ultimoRegistroPorMatricula[colaborador.id] = Date.now();
    localStorage.setItem('ultimoRegistroPorMatricula', JSON.stringify(ultimoRegistroPorMatricula));

    captureFlash.classList.add('active');
    setTimeout(() => captureFlash.classList.remove('active'), 300);

    matchImg.src = foto;
    matchImg.className = 'match-photo registered';
    matchContainer.className = 'match-container registered';
    matchName.className = 'match-name registered';
    matchName.textContent = `✅ ${colaborador.nome}`;
    matchStatus.innerHTML = `<span class="dot dot-green"></span>${esc(tipo)} às ${agora.toLocaleTimeString('pt-BR')}`;

    showToast(`✅ ${tipo}: ${colaborador.nome} — ${agora.toLocaleTimeString('pt-BR')}`, 'success');
    tocarSom('registro');
    uiLockUntil = Date.now() + 4000;
    scannerCircle.classList.add('locked');
    if (sessionAdminUnlocked) carregarHistorico();

    sincronizarAWS(registro);
  };
  tx.onerror = () => showToast('❌ Erro ao salvar o registro de ponto', 'error');
}

// ============================================================
// SINCRONIZAÇÃO OPCIONAL COM AWS / ORACLE (stub)
// ============================================================
async function sincronizarAWS(registro) {
  if (!AWS_SYNC_ENDPOINT) return; // desativado por padrão — 100% local
  try {
    await fetch(AWS_SYNC_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ empresa: CODIGO_EMPRESA_ORACLE, registro })
    });
  } catch (e) {
    console.warn('Falha ao sincronizar com AWS (registro permanece salvo localmente):', e);
  }
}

// ============================================================
// ADMIN — CADASTRO DE COLABORADOR (captura de rosto)
// ============================================================
async function capturarAmostraRosto() {
  if (!modelsReady) { showToast('⏳ Aguarde o carregamento dos modelos', 'warning'); return; }
  if (pendingDescriptors.length >= 3) { showToast('✅ Já foram capturadas 3 amostras. Clique em salvar.', 'info'); return; }

  const opts = new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 });
  const result = await faceapi.detectSingleFace(video, opts).withFaceLandmarks().withFaceDescriptor();
  if (!result) { showToast('⚠️ Nenhum rosto detectado. Posicione-se de frente para a câmera.', 'error'); return; }

  pendingDescriptors.push(Array.from(result.descriptor));
  const n = pendingDescriptors.length;
  document.getElementById('capCountLabel').textContent = String(n);
  document.getElementById(`capDot${n}`).classList.add('filled');
  document.getElementById('captureStatus').textContent = n < 3
    ? `Amostra ${n}/3 capturada. Peça para a pessoa mover levemente a cabeça e capture novamente.`
    : 'Todas as amostras capturadas! Preencha os dados e clique em "Salvar colaborador".';

  captureFlash.classList.add('active');
  setTimeout(() => captureFlash.classList.remove('active'), 300);
}

function mediaDescritores(lista) {
  const tamanho = lista[0].length;
  const media = new Array(tamanho).fill(0);
  lista.forEach(desc => desc.forEach((v, i) => media[i] += v));
  return media.map(v => v / lista.length);
}

async function cadastrarColaborador() {
  const nome = document.getElementById('newName').value.trim();
  const id = document.getElementById('newId').value.trim();
  const dept = document.getElementById('newDept').value;
  const turno = document.getElementById('newTurno').value;

  if (!nome || !id) { showToast('⚠️ Preencha nome e matrícula', 'error'); return; }
  if (!/^[\w\-. ]+$/.test(id)) { showToast('⚠️ Matrícula deve conter apenas letras, números, - . e espaço', 'error'); return; }
  if (colaboradores.some(w => w.id === id)) { showToast('⚠️ Matrícula já cadastrada!', 'error'); return; }
  if (pendingDescriptors.length < 3) { showToast('⚠️ Capture 3 amostras do rosto antes de salvar', 'error'); return; }

  const descriptor = mediaDescritores(pendingDescriptors);
  const foto = capturarFotoDoVideo(160);

  const colaborador = { id, nome, foto, departamento: dept, turno, descriptor, dataCadastro: new Date().toISOString() };

  const tx = db.transaction(['colaboradores'], 'readwrite');
  tx.objectStore('colaboradores').put(colaborador);
  tx.oncomplete = () => {
    tocarSom('cadastrado');
    showToast(`✅ ${nome} cadastrado com sucesso!`, 'success');
    document.getElementById('newName').value = '';
    document.getElementById('newId').value = '';
    pendingDescriptors = [];
    document.getElementById('capCountLabel').textContent = '0';
    [1, 2, 3].forEach(n => document.getElementById(`capDot${n}`).classList.remove('filled'));
    document.getElementById('captureStatus').textContent = 'Clique em "Capturar rosto" 3 vezes com o colaborador olhando para a câmera.';
    carregarColaboradores();
  };
  tx.onerror = () => showToast('❌ Erro ao salvar colaborador', 'error');
}

function excluirColaborador(id) {
  if (!confirm('Remover este colaborador do reconhecimento facial?')) return;
  const tx = db.transaction(['colaboradores'], 'readwrite');
  tx.objectStore('colaboradores').delete(id);
  tx.oncomplete = () => { showToast('🗑️ Colaborador removido', 'warning'); carregarColaboradores(); };
}

function carregarColaboradores() {
  if (!db) return;
  const tx = db.transaction(['colaboradores'], 'readonly');
  const req = tx.objectStore('colaboradores').getAll();
  req.onsuccess = () => {
    colaboradores = req.result || [];
    construirFaceMatcher();

    const tbody = document.getElementById('colabBody');
    document.getElementById('colabCount').textContent = String(colaboradores.length);
    if (colaboradores.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty">📭 Nenhum colaborador</td></tr>';
      return;
    }
    const turnoNome = (tid) => (turnos.find(t => String(t.id) === String(tid)) || {}).nome || tid;
    tbody.innerHTML = colaboradores.map(c => `
      <tr>
        <td><img src="${c.foto}" class="photo-preview" alt=""></td>
        <td>${esc(c.nome)}</td>
        <td>${esc(c.id)}</td>
        <td>${esc(turnoNome(c.turno))}</td>
        <td><span class="link-danger" data-id="${esc(c.id)}">remover</span></td>
      </tr>`).join('');
    tbody.querySelectorAll('.link-danger').forEach(el => el.addEventListener('click', () => excluirColaborador(el.dataset.id)));
  };
}

// ============================================================
// HISTÓRICO
// ============================================================
function carregarHistorico() {
  if (!db) return;
  const tx = db.transaction(['pontos'], 'readonly');
  const req = tx.objectStore('pontos').getAll();
  req.onsuccess = () => {
    const registros = (req.result || []).slice().reverse();
    document.getElementById('logCount').textContent = String(registros.length);
    const tbody = document.getElementById('logBody');
    if (registros.length === 0) { tbody.innerHTML = '<tr><td colspan="5" class="empty">📭 Nenhum registro</td></tr>'; return; }
    tbody.innerHTML = registros.slice(0, 40).map(p => `
      <tr>
        <td><img src="${p.foto}" class="photo-preview" alt=""></td>
        <td>${esc(p.nome)}</td>
        <td>${esc(p.matricula)}</td>
        <td>${esc(p.tipo)}</td>
        <td>${esc(p.horario)}</td>
      </tr>`).join('');
  };
}

function limparHistorico() {
  if (!confirm('⚠️ Tem certeza que deseja apagar todo o histórico de pontos? Essa ação não pode ser desfeita.')) return;
  const tx = db.transaction(['pontos'], 'readwrite');
  tx.objectStore('pontos').clear();
  tx.oncomplete = () => {
    showToast('🗑️ Histórico de pontos apagado', 'warning');
    ultimoRegistroPorMatricula = {};
    localStorage.setItem('ultimoRegistroPorMatricula', '{}');
    carregarHistorico();
  };
}

// ============================================================
// BACKUP JSON (colaboradores + pontos) — útil para migrar de tablet
// ============================================================
async function exportarBackupJSON() {
  const [colabs, pontos] = await Promise.all([
    new Promise(res => { const t = db.transaction(['colaboradores'], 'readonly'); t.objectStore('colaboradores').getAll().onsuccess = e => res(e.target.result); }),
    new Promise(res => { const t = db.transaction(['pontos'], 'readonly'); t.objectStore('pontos').getAll().onsuccess = e => res(e.target.result); })
  ]);
  const backup = { geradoEm: new Date().toISOString(), config: cfg, turnos, colaboradores: colabs, pontos };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  baixarBlob(blob, `backup_ponto_${Date.now()}.json`);
  showToast('💾 Backup gerado', 'success');
}

function baixarBlob(blob, nomeArquivo) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = nomeArquivo;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ============================================================
// RELATÓRIOS (PDF / CSV / XML)
// ============================================================
async function getRegistrosPeriodo() {
  const ini = document.getElementById('relDataIni').value;
  const fim = document.getElementById('relDataFim').value;
  return new Promise((resolve) => {
    const tx = db.transaction(['pontos'], 'readonly');
    const req = tx.objectStore('pontos').getAll();
    req.onsuccess = () => {
      let registros = req.result || [];
      if (ini) registros = registros.filter(r => r.dataKey >= ini);
      if (fim) registros = registros.filter(r => r.dataKey <= fim);
      registros.sort((a, b) => a.horarioISO.localeCompare(b.horarioISO));
      resolve(registros);
    };
    req.onerror = () => resolve([]);
  });
}

function exportarPDFDetalhado() {
  getRegistrosPeriodo().then(registros => {
    if (registros.length === 0) { showToast('📭 Nenhum registro no período selecionado', 'warning'); return; }
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    doc.setFontSize(16);
    doc.text(`Relatório de Ponto — ${cfg.empresaNome}`, 14, 16);
    doc.setFontSize(10);
    doc.text(`Emitido em ${formatDateTimeBR()} | ${registros.length} registro(s)`, 14, 23);

    doc.autoTable({
      startY: 28,
      head: [['Colaborador', 'Matrícula', 'Tipo', 'Data/Hora', 'Turno']],
      body: registros.map(r => [r.nome, r.matricula, r.tipo, r.horario, r.turno]),
      styles: { fontSize: 8 },
      headStyles: { fillColor: [16, 185, 129] }
    });
    doc.save(`relatorio_ponto_${Date.now()}.pdf`);
    showToast('📄 PDF gerado', 'success');
  });
}

function calcularHorasTrabalhadas(registrosDoDia) {
  // Espera a sequência Entrada, Intervalo-Saída, Intervalo-Retorno, Saída
  const porTipo = {};
  registrosDoDia.forEach(r => { (porTipo[r.tipo] ||= []).push(r); });
  const entrada = porTipo['Entrada']?.[0];
  const saida = porTipo['Saída']?.[0];
  const intSaida = porTipo['Intervalo - Saída']?.[0];
  const intRetorno = porTipo['Intervalo - Retorno']?.[0];
  if (!entrada || !saida) return null;
  let totalMs = new Date(saida.horarioISO) - new Date(entrada.horarioISO);
  if (intSaida && intRetorno) totalMs -= (new Date(intRetorno.horarioISO) - new Date(intSaida.horarioISO));
  if (totalMs < 0) return null;
  const horas = totalMs / 3600000;
  return horas;
}

function exportarPDFResumoHoras() {
  getRegistrosPeriodo().then(registros => {
    if (registros.length === 0) { showToast('📭 Nenhum registro no período selecionado', 'warning'); return; }
    // agrupa por matrícula + dia
    const grupos = {};
    registros.forEach(r => { const k = `${r.matricula}|${r.dataKey}`; (grupos[k] ||= []).push(r); });

    const linhas = Object.entries(grupos).map(([k, regs]) => {
      const [matricula, dataKey] = k.split('|');
      const nome = regs[0].nome;
      const horas = calcularHorasTrabalhadas(regs);
      return [nome, matricula, dataKey, regs.length + '/4', horas != null ? horas.toFixed(2) + 'h' : 'incompleto'];
    }).sort((a, b) => (a[0] + a[2]).localeCompare(b[0] + b[2]));

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    doc.setFontSize(16);
    doc.text(`Resumo de Horas — ${cfg.empresaNome}`, 14, 16);
    doc.setFontSize(10);
    doc.text(`Emitido em ${formatDateTimeBR()}`, 14, 23);
    doc.autoTable({
      startY: 28,
      head: [['Colaborador', 'Matrícula', 'Data', 'Batidas', 'Total no dia']],
      body: linhas,
      styles: { fontSize: 8 },
      headStyles: { fillColor: [6, 182, 212] }
    });
    doc.save(`resumo_horas_${Date.now()}.pdf`);
    showToast('📊 PDF de resumo gerado', 'success');
  });
}

function exportarXMLOracle() {
  getRegistrosPeriodo().then(registros => {
    if (registros.length === 0) { showToast('📭 Nenhum registro no período selecionado', 'warning'); return; }
    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
    xml += `<IntegracaoPonto>\n`;
    xml += `  <!-- Ajuste as tags/campos abaixo conforme o layout exigido pela integração Oracle da sua empresa -->\n`;
    xml += `  <SistemaDestino>Oracle</SistemaDestino>\n`;
    xml += `  <CodigoEmpresa>${esc(CODIGO_EMPRESA_ORACLE)}</CodigoEmpresa>\n`;
    xml += `  <DataGeracao>${new Date().toISOString()}</DataGeracao>\n`;
    xml += `  <Registros>\n`;
    registros.forEach(p => {
      xml += `    <PontoBiometrico>\n`;
      xml += `      <Colaborador>${esc(p.nome)}</Colaborador>\n`;
      xml += `      <Matricula>${esc(p.matricula)}</Matricula>\n`;
      xml += `      <TipoBatida>${esc(p.tipo)}</TipoBatida>\n`;
      xml += `      <DataHoraISO>${esc(p.horarioISO)}</DataHoraISO>\n`;
      xml += `      <Turno>${esc(p.turno)}</Turno>\n`;
      xml += `      <Departamento>${esc(p.departamento || '')}</Departamento>\n`;
      xml += `    </PontoBiometrico>\n`;
    });
    xml += `  </Registros>\n`;
    xml += `</IntegracaoPonto>`;
    baixarBlob(new Blob([xml], { type: 'application/xml' }), `integracao_oracle_${Date.now()}.xml`);
    showToast('📄 XML exportado', 'success');
  });
}

function exportarCSV() {
  getRegistrosPeriodo().then(registros => {
    if (registros.length === 0) { showToast('📭 Nenhum registro no período selecionado', 'warning'); return; }
    const linhas = ['Colaborador;Matricula;Tipo;DataHora;Turno;Departamento'];
    registros.forEach(p => linhas.push([p.nome, p.matricula, p.tipo, p.horario, p.turno, p.departamento || ''].join(';')));
    baixarBlob(new Blob(['\uFEFF' + linhas.join('\n')], { type: 'text/csv;charset=utf-8' }), `relatorio_ponto_${Date.now()}.csv`);
    showToast('📊 CSV exportado', 'success');
  });
}

// ============================================================
// INICIALIZAÇÃO
// ============================================================
async function iniciar() {
  carregarConfig();
  try {
    loadingSub.textContent = 'Preparando banco de dados local...';
    db = await abrirBanco();

    await carregarModelos();

    loadingSub.textContent = 'Solicitando acesso à câmera...';
    await iniciarCamera();

    carregarColaboradores();
    renderTurnosConfig();
    iniciarLoopDeteccao();

    loadingOverlay.classList.remove('active');
    showToast('📸 Sistema pronto. Reconhecimento automático ativo.', 'success');
  } catch (err) {
    console.error(err);
    loadingSub.textContent = 'Falha ao iniciar. Verifique a permissão da câmera e recarregue a página.';
  }
}

iniciar();
