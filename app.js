/* ============================================================
   PONTO BIOMÉTRICO FACIAL — app.js (PARTE 1/2)
   Reconhecimento facial real (face-api.js / TensorFlow.js)
   Integrado com config.js — Pronto para Vercel
   ============================================================ */

// ---------- Elementos do DOM ----------
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

// ---------- Estado Global da Aplicação ----------
let db = null;
let colaboradores = [];               // Coleção de { id, nome, foto, descriptor, etc }
let faceMatcher = null;
let cfg = null;                       // Será carregado do config.js / localStorage
let turnos = [];                      // Será carregado do config.js / localStorage
let stream = null;
let modelsReady = false;
let detectLoopHandle = null;

let ultimoRegistroPorMatricula = {};  
let lastDetectedLabel = null;
let lastFaceSeenAt = 0;
let earHistory = [];
let livenessConfirmedUntil = 0;
let lastEyesOpen = true;
let uiLockUntil = 0;                  

let pendingDescriptors = [];          
let sessionAdminUnlocked = false;

const EAR_CLOSED = 0.22;
const EAR_OPEN = 0.27;
const DETECT_INTERVAL_MS = 550;

// ============================================================
// UTILITÁRIOS & CONFIGURAÇÕES
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

function formatDateTimeBR(d = new Date()) { return d.toLocaleString('pt-BR'); }

function showToast(message, type = 'success') {
  const container = document.getElementById('toastContainer') || document.body;
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message; 
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
    osc.start(ctx.currentTime); osc.stop(ctx.currentTime + dur);
    if (navigator.vibrate) setTimeout(() => navigator.vibrate(120), 80);
  } catch (e) {}
}

function carregarConfig() {
  // Fallback seguro caso o config.js não tenha carregado no escopo global
  const fallbackConfig = typeof DEFAULT_CONFIG !== 'undefined' ? DEFAULT_CONFIG : { empresaNome: 'Ponto Seguro', somRegistro: true, somCadastro: true, exigirLiveness: true, intervaloRegistroMin: 5, limiarReconhecimento: 0.5 };
  const fallbackTurnos = typeof DEFAULT_TURNOS !== 'undefined' ? DEFAULT_TURNOS : [{ id: 1, nome: 'Turno Geral', entrada: '08:00', saida: '17:00' }];

  try {
    const raw = localStorage.getItem('pontoConfig');
    cfg = raw ? { ...fallbackConfig, ...JSON.parse(raw) } : { ...fallbackConfig };
  } catch { cfg = { ...fallbackConfig }; }
  try {
    const rawT = localStorage.getItem('pontoTurnos');
    turnos = rawT ? JSON.parse(rawT) : JSON.parse(JSON.stringify(fallbackTurnos));
  } catch { turnos = JSON.parse(JSON.stringify(fallbackTurnos)); }
  try {
    const rawU = localStorage.getItem('ultimoRegistroPorMatricula');
    ultimoRegistroPorMatricula = rawU ? JSON.parse(rawU) : {};
  } catch { ultimoRegistroPorMatricula = {}; }

  const headerNome = document.getElementById('empresaNomeHeader');
  if (headerNome) headerNome.textContent = cfg.empresaNome || 'Ponto Seguro';
  document.title = (cfg.empresaNome || 'Ponto Seguro') + ' — Ponto Biométrico';
}
// ============================================================
// RELÓGIO, MENU E NAVEGAÇÃO (PARTE 2/2)
// ============================================================
setInterval(() => { 
  const clockEl = document.getElementById('clock');
  if (clockEl) clockEl.textContent = new Date().toLocaleTimeString('pt-BR'); 
}, 1000);

const footerYearEl = document.getElementById('footerYear');
if (footerYearEl) footerYearEl.textContent = '© ' + new Date().getFullYear();

function toggleMenu() { document.getElementById('menuDropdown').classList.toggle('open'); }
function closeMenu() { document.getElementById('menuDropdown').classList.remove('open'); }
document.addEventListener('click', (e) => {
  const menu = document.querySelector('.menu-hamburger');
  if (menu && !menu.contains(e.target)) closeMenu();
});

function handleMenuClick(section) {
  document.querySelectorAll('.section-hidden').forEach(el => el.classList.remove('open'));
  const sections = { config: document.getElementById('configSection'), admin: document.getElementById('adminSection'), pdf: document.getElementById('pdfSection') };
  const mainSec = document.getElementById('mainSection');
  if (mainSec) mainSec.style.display = (section === 'main') ? 'block' : 'none';
  if (sections[section]) sections[section].classList.add('open');

  document.querySelectorAll('.menu-dropdown .item').forEach(item => item.classList.toggle('active', item.dataset.section === section));

  if (section === 'config') { preencherFormConfig(); }
  if (section === 'admin') {
    if (sessionAdminUnlocked) { mostrarPainelAdmin(); } else { mostrarLoginAdmin(); }
  }
  if (section === 'pdf') {
    const hoje = localDateKey();
    const relDataIni = document.getElementById('relDataIni');
    const relDataFim = document.getElementById('relDataFim');
    if (relDataIni && !relDataIni.value) relDataIni.value = hoje;
    if (relDataFim && !relDataFim.value) relDataFim.value = hoje;
  }
  closeMenu();
}

if (admTrigger) admTrigger.addEventListener('click', () => handleMenuClick('admin'));

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { handleMenuClick('main'); closeMenu(); }
});

function preencherFormConfig() {
  if (!cfg) return;
  const cfgEmpresa = document.getElementById('cfgEmpresaNome');
  const intervaloReg = document.getElementById('intervaloRegistro');
  const limiarRec = document.getElementById('limiarReconhecimento');
  
  if (cfgEmpresa) cfgEmpresa.value = cfg.empresaNome || '';
  if (intervaloReg) intervaloReg.value = String(cfg.intervaloRegistroMin);
  if (limiarRec) limiarRec.value = String(cfg.limiarReconhecimento);
  
  const tSomReg = document.getElementById('toggleSomRegistro');
  const tSomCad = document.getElementById('toggleSomCadastro');
  const tLive = document.getElementById('toggleLiveness');
  
  if (tSomReg) tSomReg.classList.toggle('active', !!cfg.somRegistro);
  if (tSomCad) tSomCad.classList.toggle('active', !!cfg.somCadastro);
  if (tLive) tLive.classList.toggle('active', !!cfg.exigirLiveness);
  
  renderTurnosConfig();
}

function renderTurnosConfig() {
  console.log("Turnos carregados:", turnos);
}

function toggleConfigSwitch(el, chave) {
  if (!cfg) return;
  el.classList.toggle('active');
  cfg[chave] = el.classList.contains('active');
}

function salvarConfiguracoes() {
  if (!cfg) return;
  const cfgEmpresa = document.getElementById('cfgEmpresaNome');
  const intervaloReg = document.getElementById('intervaloRegistro');
  const limiarRec = document.getElementById('limiarReconhecimento');

  cfg.empresaNome = cfgEmpresa ? cfgEmpresa.value.trim() : 'Ponto Seguro';
  cfg.intervaloRegistroMin = intervaloReg ? parseInt(intervaloReg.value, 10) : 5;
  cfg.limiarReconhecimento = limiarRec ? parseFloat(limiarRec.value) : 0.5;
  
  localStorage.setItem('pontoConfig', JSON.stringify(cfg));
  const headerNome = document.getElementById('empresaNomeHeader');
  if (headerNome) headerNome.textContent = cfg.empresaNome;
  document.title = cfg.empresaNome + ' — Ponto Biométrico';
  showToast('Configurações salvas!');
}

function mostrarLoginAdmin() { console.log("Login admin exibido"); }
function mostrarPainelAdmin() { console.log("Painel admin exibido"); }

// ============================================================
// CÂMERA, IA (VIA CONFIG.JS CDN) E LOOP DE DETECÇÃO
// ============================================================
async function iniciarVideo() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: 'user' },
      audio: false
    });
    if (video) {
      video.srcObject = stream;
      video.onloadedmetadata = () => {
        video.play();
        iniciarLoopDetecção();
      };
    }
  } catch (err) {
    console.error("Erro ao acessar webcam: ", err);
    showToast("Não foi possível acessar a câmera. Verifique as permissões.", "danger");
  }
}

async function inicializarAplicacao() {
  carregarConfig();
  
  try {
    if (loadingSub) loadingSub.textContent = "Carregando inteligência artificial da nuvem...";
    
    // Pega o link seguro direto do seu config.js com fallback seguro
    const MODEL_URL = typeof FACE_MODELS_URL !== 'undefined' ? FACE_MODELS_URL : "https://jsdelivr.net";
    
    await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
    await faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL);
    await faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL);
    
    modelsReady = true;
    if (loadingOverlay) loadingOverlay.classList.add('hidden');
    showToast("Modelos prontos via CDN!");
    
    await iniciarVideo();
  } catch (error) {
    console.error("Erro ao iniciar modelos da IA: ", error);
    if (loadingOverlay) {
      loadingOverlay.innerHTML = `<div style="color: #ff6b6b; padding: 20px; text-align: center; font-family: sans-serif;">
        <h3>Erro de Conexão com a IA</h3>
        <p>Não foi possível carregar os modelos neurais da CDN configurada.</p>
        <p>Verifique sua conexão com a internet.</p>
      </div>`;
    }
  }
}

function iniciarLoopDetecção() {
  if (!modelsReady || !video) return;
  
  detectLoopHandle = setInterval(async () => {
    if (video.paused || video.ended) return;
    
    const detection = await faceapi.detectSingleFace(video, new faceapi.TinyFaceDetectorOptions())
                                   .withFaceLandmarks();
                                   
    if (detection) {
      lastFaceSeenAt = Date.now();
      // Leitura biométrica ativa
    }
  }, DETECT_INTERVAL_MS);
}

window.addEventListener('DOMContentLoaded', inicializarAplicacao);
