const FACE_MODELS_URL = "https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@0.22.2/weights";
const AWS_SYNC_ENDPOINT = "";
const CODIGO_EMPRESA_ORACLE = "EMPRESA_TRANSPORTE_001";
const DEFAULT_CONFIG = {
  empresaNome: "Ponto Seguro",
  somRegistro: true,
  somCadastro: true,
  exigirLiveness: true,
  intervaloRegistroMin: 5,
  limiarReconhecimento: 0.5,
  adminPinHash: ""
};
const DEFAULT_TURNOS = [
  { id: 1, nome: "Turno 1 - Manhã", entrada: "08:10", intervaloInicio: "12:00", intervaloFim: "13:30", saida: "17:00" },
  { id: 2, nome: "Turno 2 - Tarde", entrada: "19:00", intervaloInicio: "23:00", intervaloFim: "23:20", saida: "02:20" }
];
const TIPOS_BATIDA = ["Entrada", "Intervalo - Saída", "Intervalo - Retorno", "Saída"];