/* ============================================================
   CONFIG.JS
   Configurações padrão do sistema. Podem ser alteradas pela tela
   "Configurações" dentro do app (ficam salvas no navegador/tablet),
   ou editadas aqui antes de publicar, se preferir um padrão fixo.
   ============================================================ */

// Onde os modelos de reconhecimento facial (face-api.js) são carregados.
// São arquivos de pesos de uma rede neural já treinada — não enviamos
// nenhuma imagem para fora do dispositivo para usar esse recurso.
const FACE_MODELS_URL = "https://cdn.jsdelivr.net/gh/justadudewhohacks/[email protected]/weights";

// Endpoint opcional (AWS API Gateway + Lambda) para sincronizar os
// registros de ponto com um backend central / integração Oracle.
// Deixe em branco ("") para operar 100% offline, salvando apenas
// neste tablet. Veja aws-integration/README.md para detalhes.
const AWS_SYNC_ENDPOINT = "";

// Código da empresa usado nas exportações (XML/CSV), útil para a
// integração com o sistema Oracle usado pelo RH.
const CODIGO_EMPRESA_ORACLE = "EMPRESA_TRANSPORTE_001";

const DEFAULT_CONFIG = {
  empresaNome: "Ponto Seguro",
  somRegistro: true,
  somCadastro: true,
  exigirLiveness: true,
  intervaloRegistroMin: 5,
  limiarReconhecimento: 0.5,
  adminPinHash: "" // definido no primeiro acesso administrativo
};

// Dois turnos padrão típicos de empresa de ônibus (com intervalo).
// O horário aqui é só referência para os relatórios — o tipo de cada
// batida (Entrada / Intervalo / Retorno / Saída) é sempre calculado
// automaticamente pela ordem das batidas do colaborador no dia.
const DEFAULT_TURNOS = [
  { id: 1, nome: "Turno 1 - Manhã", entrada: "05:00", intervaloInicio: "09:00", intervaloFim: "09:20", saida: "13:00" },
  { id: 2, nome: "Turno 2 - Tarde", entrada: "13:00", intervaloInicio: "17:00", intervaloFim: "17:20", saida: "21:00" }
];

const TIPOS_BATIDA = ["Entrada", "Intervalo - Saída", "Intervalo - Retorno", "Saída"];
