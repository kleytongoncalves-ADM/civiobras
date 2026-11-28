/**
 * Motor do visualizador 3D (Three.js). Recebe a cena já calculada no servidor (cena-3d.ts) e cuida só de desenhar:
 * carrega os modelos da biblioteca, monta pilhas, montes, kits e equipes, toca as animações gravadas no Blender
 * e anima as mudanças de quantidade.
 */
import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import * as CANNON from "cannon-es";
import { clone as clonarComEsqueleto } from "three/examples/jsm/utils/SkeletonUtils.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { Sky } from "three/examples/jsm/objects/Sky.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { GTAOPass } from "three/examples/jsm/postprocessing/GTAOPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { CSS2DObject, CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import type { CenaItem, Peca, Visual } from "@/servicos/cena-3d";
import type { Acabamento, LocalObra } from "@/servicos/obra-3d";

export const CAMINHO_MODELOS = "/biblioteca-3d/modelos";
const CAMINHO_TERRENO = "/biblioteca-3d/terreno";

type Opcoes = {
  escuro: boolean;
  animacoes: boolean;
  onSelecionar?: (itemId: string) => void;
  onApontar?: (a: Apontado) => void;
  onMedir?: (m: Medida | null) => void;
  /** Projeto IFC: grupo de elementos sob o ponteiro. */
  onApontarProjeto?: (a: { ordem: number; x: number; y: number } | null) => void;
};

/** Grupo de elementos do projeto IFC, com os itens do orçamento lançados a partir dele. */
export type GrupoProjeto = { ordem: number; cor: [number, number, number, number]; posicoes: Float32Array; indices: Uint32Array; itens: string[] };
type MalhaProjeto = { ordem: number; itens: string[]; malha: THREE.Mesh; material: THREE.MeshStandardMaterial; cor: THREE.Color; alfa: number };
const COR_SEM_ITEM = new THREE.Color(0xcdd3d6), COR_SELECAO = new THREE.Color(0xf28c28);

export type Vista = "perspectiva" | "superior" | "frente" | "lado" | "planta";
export type Apontado = { itemId: string; x: number; y: number } | null;
export type Medida = { pontos: number; comprimento: number; area: number | null; desnivel: number };
export type Filtro = ((estacaoId: string, papel: Peca["papel"]) => boolean) | null;

const DIRECAO: Record<Vista, [number, number, number]> = {
  perspectiva: [0.25, 0.95, 1], superior: [0, 1, 0.0015], planta: [0, 1, 0.0015], frente: [0, 0.14, 1], lado: [1, 0.14, 0],
};
const FOV = 38, FOV_PLANTA = 11;
const MAT_FANTASMA = new THREE.MeshStandardMaterial({ color: 0xa9b6ba, transparent: true, opacity: 0.14, depthWrite: false, roughness: 1 });
const MAT_MEDIDA = new THREE.MeshBasicMaterial({ color: 0xf28c28, depthTest: false });
const metros = (v: number) => `${v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} m`;

export type ModoCena = "canteiro" | "item" | "obra" | "projeto";

type Estacao = {
  itemId: string;
  grupo: THREE.Group;
  pecas: { peca: Peca; grupo: THREE.Group; chave: string }[];
  rotulo?: CSS2DObject;
};

type Tarefa = { inicio: number; duracao: number; passo: (t: number) => void; fim?: () => void };

const suave = (t: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);

// ---------------------------------------------------------------------------
// Carregamento com cache
// ---------------------------------------------------------------------------
let carregador: GLTFLoader | null = null;
const cache = new Map<string, Promise<GLTF>>();

function loader() {
  if (!carregador) {
    const draco = new DRACOLoader();
    draco.setDecoderPath("/biblioteca-3d/draco/");
    carregador = new GLTFLoader();
    carregador.setDRACOLoader(draco);
  }
  return carregador;
}

function carregar(url: string): Promise<GLTF> {
  let p = cache.get(url);
  if (!p) {
    p = loader().loadAsync(url);
    p.catch(() => cache.delete(url));
    cache.set(url, p);
  }
  return p;
}

const urlModelo = (codigo: string, leve: boolean) => `${CAMINHO_MODELOS}/${codigo}${leve ? "_lod1" : ""}.glb`;
const urlAnimacao = (codigo: string) => `${CAMINHO_MODELOS}/${codigo}_anim.glb`;
const urlVideo = (codigo: string) => `${CAMINHO_MODELOS}/${codigo}_anim.webm`;

function prepararSombras(o: THREE.Object3D) {
  o.traverse((n) => {
    const m = n as THREE.Mesh;
    if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; }
  });
}

function caixa(o: THREE.Object3D) {
  o.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(o, true);
}

/** Caixa só do que aparece: malhas visíveis, sem o que está escondido dentro do modelo. */
/** Mãos da equipe: os dedos vêm abertos e retos do Blender; aqui ganham a curva natural de quem segura a ferramenta. */
const CURVA_DEDO = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.45);
function fecharMaos(clip: THREE.AnimationClip) {
  if (clip.userData?.maosFechadas) return;
  const q = new THREE.Quaternion();
  for (const faixa of clip.tracks) {
    if (!/^finger[2-5]-[123][._]?[LR]\.quaternion$/.test(faixa.name)) continue;
    const v = faixa.values;
    for (let i = 0; i < v.length; i += 4) { q.fromArray(v, i).multiply(CURVA_DEDO).toArray(v, i); }
  }
  clip.userData = { ...clip.userData, maosFechadas: true };
}

function caixaVisivel(o: THREE.Object3D) {
  o.updateMatrixWorld(true);
  const bb = new THREE.Box3();
  const visita = (n: THREE.Object3D) => {
    if (!n.visible) return;
    if ((n as THREE.Mesh).isMesh) bb.union(new THREE.Box3().setFromObject(n, true));
    for (const c of n.children) visita(c);
  };
  visita(o);
  return bb.isEmpty() ? caixa(o) : bb;
}

// ---------------------------------------------------------------------------
// Almoxarifado: suportes desenhados aqui mesmo (palete, cavalete, estante, baia, vaga)
// ---------------------------------------------------------------------------
const MAT_MADEIRA = new THREE.MeshStandardMaterial({ color: 0xc8a064, roughness: 0.85 });
const MAT_CONCRETO = new THREE.MeshStandardMaterial({ color: 0xb4b8ba, roughness: 0.95 });
const MAT_ACO = new THREE.MeshStandardMaterial({ color: 0x1f5d6b, roughness: 0.5, metalness: 0.35 });
const MAT_FAIXA = new THREE.MeshStandardMaterial({ color: 0xf2b428, roughness: 0.9 });
const MAT_FAIXA_EQUIPE = new THREE.MeshStandardMaterial({ color: 0x2f8ea1, roughness: 0.9 });
const CUBO = new THREE.BoxGeometry(1, 1, 1);
const G = 9.81;

/** Número pseudoaleatório estável por índice: a mesma peça cai sempre do mesmo jeito. */
const corDoGranel = (nome: string) => /brita|pedra|cascalho|p[oó] de pedra/i.test(nome) ? 0x8f9194 : /terra|solo|argila|saibro/i.test(nome) ? 0x8a6a4a : 0xd8c08e;

function acaso(k: number, s: number) { const x = Math.sin(k * 12.9898 + s * 78.233) * 43758.5453; return x - Math.floor(x); }

/** Textura de ruído granulado (terra batida, brita, concreto), desenhada em canvas. */

/** Textura desenhada por metro quadrado de superfície, para os acabamentos da obra. */
function texturaAcabamento(a: Acabamento): { mapa: THREE.CanvasTexture; metro: number; rugosidade: number; relevo: number } {
  const n = 512, c = document.createElement("canvas");
  c.width = c.height = n;
  const x = c.getContext("2d")!;
  const ruido = (base: [number, number, number], v: number) => {
    const img = x.createImageData(n, n);
    for (let i = 0; i < n * n; i++) { const r = (Math.random() - 0.5) * v; img.data[i * 4] = base[0] + r; img.data[i * 4 + 1] = base[1] + r; img.data[i * 4 + 2] = base[2] + r; img.data[i * 4 + 3] = 255; }
    x.putImageData(img, 0, 0);
  };
  const manchas = (qtd: number, forca: number, raioMax: number) => {
    for (let i = 0; i < qtd; i++) {
      const px = Math.random() * n, py = Math.random() * n, raio = 8 + Math.random() * raioMax;
      const g = x.createRadialGradient(px, py, 0, px, py, raio);
      g.addColorStop(0, Math.random() < 0.55 ? `rgba(0,0,0,${forca})` : `rgba(255,255,255,${forca})`); g.addColorStop(1, "rgba(0,0,0,0)");
      x.fillStyle = g;
      for (const dx of [-n, 0, n]) for (const dy of [-n, 0, n]) { x.beginPath(); x.arc(px + dx, py + dy, raio, 0, Math.PI * 2); x.fill(); }
    }
  };
  let metro = 1, rugosidade = 0.95, relevo = 0.4;
  if (a === "bloco") {
    // Bloco cerâmico 19 x 19 cm com junta de 1 cm: 5 fiadas por metro, amarração a meio bloco.
    ruido([176, 96, 62], 26);
    manchas(90, 0.07, 60);
    const passo = n / 5, junta = Math.max(3, n * 0.012);
    x.fillStyle = "#b9b4a8";
    for (let f = 0; f < 5; f++) {
      x.fillRect(0, f * passo - junta / 2, n, junta);
      for (let k = 0; k < 6; k++) x.fillRect(k * passo + (f % 2 ? passo / 2 : 0) - junta / 2, f * passo, junta, passo);
      for (let k = 0; k < 6; k++) { x.fillStyle = `rgba(${90 + Math.random() * 30},40,20,0.10)`; x.fillRect(k * passo + (f % 2 ? passo / 2 : 0) + junta, f * passo + junta + Math.random() * passo * 0.5, passo - junta * 2, 2); x.fillStyle = "#b9b4a8"; }
    }
    x.fillRect(0, n - junta / 2, n, junta);
    relevo = 1.2;
  } else if (a === "chapisco") {
    ruido([118, 116, 110], 70); manchas(500, 0.16, 8); relevo = 2.2; metro = 0.8;
  } else if (a === "reboco") {
    ruido([186, 182, 172], 16); manchas(160, 0.05, 80); relevo = 0.5; metro = 1.5;
  } else if (a === "massa") {
    ruido([232, 229, 220], 6); manchas(60, 0.025, 110); relevo = 0.1; rugosidade = 0.85; metro = 2;
  } else if (a === "pintura") {
    ruido([243, 240, 231], 4); manchas(40, 0.015, 140); relevo = 0.08; rugosidade = 0.62; metro = 2.5;
  } else if (a === "concreto") {
    ruido([158, 157, 152], 20); manchas(220, 0.06, 50);
    x.strokeStyle = "rgba(60,60,58,0.25)"; x.lineWidth = 2;
    for (let i = 1; i < 3; i++) { x.beginPath(); x.moveTo(0, (i * n) / 3); x.lineTo(n, (i * n) / 3); x.stroke(); }
    relevo = 0.6; metro = 1.2;
  } else if (a === "piso") {
    // Placas de 50 x 50 cm com rejunte.
    ruido([214, 204, 188], 10); manchas(120, 0.035, 70);
    x.strokeStyle = "#8f8a80"; x.lineWidth = 4;
    for (let i = 0; i <= 2; i++) { x.beginPath(); x.moveTo((i * n) / 2, 0); x.lineTo((i * n) / 2, n); x.stroke(); x.beginPath(); x.moveTo(0, (i * n) / 2); x.lineTo(n, (i * n) / 2); x.stroke(); }
    relevo = 0.25; rugosidade = 0.45;
  } else {
    // Telha cerâmica em fiadas.
    ruido([170, 84, 52], 24); manchas(120, 0.08, 40);
    for (let k = 0; k < 5; k++) { const g = x.createLinearGradient((k * n) / 5, 0, ((k + 1) * n) / 5, 0); g.addColorStop(0, "rgba(0,0,0,0.30)"); g.addColorStop(0.5, "rgba(255,255,255,0.14)"); g.addColorStop(1, "rgba(0,0,0,0.30)"); x.fillStyle = g; x.fillRect((k * n) / 5, 0, n / 5, n); }
    x.fillStyle = "rgba(0,0,0,0.28)"; for (let f = 0; f < 3; f++) x.fillRect(0, (f * n) / 3, n, 5);
    relevo = 1.6;
  }
  const mapa = new THREE.CanvasTexture(c);
  mapa.wrapS = mapa.wrapT = THREE.RepeatWrapping;
  mapa.colorSpace = THREE.SRGBColorSpace;
  mapa.anisotropy = 8;
  return { mapa, metro, rugosidade, relevo };
}

/** Veios de madeira para paletes e prateleiras. */

function grao(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const x = c.getContext("2d")!;
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, "rgba(255,255,255,1)"); g.addColorStop(0.5, "rgba(255,255,255,0.55)"); g.addColorStop(1, "rgba(255,255,255,0)");
  x.fillStyle = g; x.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

function bloco(g: THREE.Group, mat: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number, sombra = true) {
  const m = new THREE.Mesh(CUBO, mat);
  m.scale.set(w, h, d);
  m.position.set(x, y + h / 2, z);
  m.castShadow = sombra; m.receiveShadow = true;
  g.add(m);
}

type TipoSuporte = "palete" | "cavalete" | "estante" | "baia" | "vaga" | "equipe";

function tipoSuporte(p: Peca, t: THREE.Vector3): TipoSuporte {
  if (p.papel === "mao_de_obra") return "equipe";
  if (p.papel === "equipamento" || p.papel === "kit" || p.visual.tipo === "maquina") return "vaga";
  if (p.visual.tipo === "monte") return "baia";
  if (p.visual.tipo === "pilha" && p.visual.arranjo === "feixe" && Math.max(t.x, t.z) > 1.5) return "cavalete";
  if (Math.max(t.x, t.z) < 0.9 && t.y < 1) return "estante";
  return "palete";
}

/** Suporte sob uma peça de tamanho `t`, centrado na origem. Devolve também quanto a peça sobe. */
function criarSuporte(tipo: TipoSuporte, t: THREE.Vector3): { grupo: THREE.Group; elevacao: number } {
  const g = new THREE.Group();
  if (tipo === "palete") {
    const w = t.x + 0.16, d = t.z + 0.16;
    for (const z of [-d / 2 + 0.05, 0, d / 2 - 0.05]) bloco(g, MAT_MADEIRA, w, 0.09, 0.09, 0, 0, z);
    const n = Math.max(3, Math.min(12, Math.round(w / 0.17)));
    for (let i = 0; i < n; i++) bloco(g, MAT_MADEIRA, (w / n) * 0.72, 0.03, d, -w / 2 + (w / n) * (i + 0.5), 0.09, 0);
    return { grupo: g, elevacao: 0.12 };
  }
  if (tipo === "cavalete") {
    const longoX = t.x >= t.z;
    const L = longoX ? t.x : t.z, S = (longoX ? t.z : t.x) + 0.3;
    const n = L > 6 ? 3 : 2;
    for (let i = 0; i < n; i++) {
      const a = -L / 2 + L * (n === 2 ? [0.2, 0.8][i] : [0.12, 0.5, 0.88][i]);
      const c = new THREE.Group();
      bloco(c, MAT_ACO, 0.08, 0.08, S, 0, 0.32, 0);
      for (const z of [-S / 2 + 0.05, S / 2 - 0.05]) { bloco(c, MAT_ACO, 0.06, 0.32, 0.06, 0, 0, z); bloco(c, MAT_ACO, 0.4, 0.04, 0.06, 0, 0, z); bloco(c, MAT_ACO, 0.05, 0.22, 0.05, 0, 0.4, z); }
      if (longoX) c.position.x = a; else { c.rotation.y = Math.PI / 2; c.position.z = a; }
      g.add(c);
    }
    return { grupo: g, elevacao: 0.4 };
  }
  if (tipo === "estante") {
    const w = Math.max(t.x + 0.3, 0.9), d = Math.max(t.z + 0.2, 0.5), base = 0.45, alto = base + t.y + 0.3;
    for (const x of [-w / 2, w / 2]) for (const z of [-d / 2, d / 2]) bloco(g, MAT_ACO, 0.04, alto, 0.04, x, 0, z);
    for (const y of [0.1, base - 0.03, alto - 0.03]) bloco(g, MAT_MADEIRA, w, 0.03, d, 0, y, 0);
    return { grupo: g, elevacao: base };
  }
  if (tipo === "baia") {
    const w = t.x + 0.5, d = t.z + 0.4, h = Math.max(0.5, Math.min(1.4, t.y * 0.75)), e = 0.14;
    bloco(g, MAT_CONCRETO, w + e * 2, h, e, 0, 0, -d / 2 - e / 2);
    for (const x of [-w / 2 - e / 2, w / 2 + e / 2]) bloco(g, MAT_CONCRETO, e, h, d * 0.85, x, 0, -d / 2 + (d * 0.85) / 2);
    return { grupo: g, elevacao: 0 };
  }
  // Vaga pintada no chão: máquinas (amarelo) e equipe (azul).
  const mat = tipo === "vaga" ? MAT_FAIXA : MAT_FAIXA_EQUIPE;
  const w = t.x + 0.5, d = t.z + 0.5, f = 0.07;
  for (const z of [-d / 2, d / 2]) bloco(g, mat, w + f, 0.012, f, 0, 0.004, z, false);
  for (const x of [-w / 2, w / 2]) bloco(g, mat, f, 0.012, d, x, 0.004, 0, false);
  return { grupo: g, elevacao: 0 };
}

const reais = (v: number) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

// ---------------------------------------------------------------------------
// Montagem das peças
// ---------------------------------------------------------------------------
function posicoesPilha(n: number, tam: THREE.Vector3, arranjo: string): THREE.Matrix4[] {
  const r: THREE.Matrix4[] = [];
  const folga = 1.03;
  if (arranjo === "chapas") {
    for (let i = 0; i < n; i++) r.push(new THREE.Matrix4().makeTranslation(0, i * tam.y * 1.01, 0));
    return r;
  }
  if (arranjo === "feixe") {
    // Barras deitadas lado a lado, em camadas que diminuem para cima.
    const longoEmZ = tam.z > tam.x;
    const largura = (longoEmZ ? tam.x : tam.z) * folga;
    const altura = Math.max(tam.y, largura * 0.9);
    const porCamada = Math.max(1, Math.ceil(Math.sqrt(n) * 1.6));
    let i = 0;
    for (let c = 0; i < n; c++) {
      const naCamada = Math.max(1, porCamada - c);
      for (let j = 0; j < naCamada && i < n; j++, i++) {
        const lateral = (j - (naCamada - 1) / 2) * largura;
        const m = new THREE.Matrix4().makeTranslation(longoEmZ ? lateral : 0, c * altura, longoEmZ ? 0 : lateral);
        r.push(m);
      }
    }
    return r;
  }
  const porCamada = Math.max(1, Math.min(arranjo === "rolos" ? 16 : 49, Math.ceil(Math.pow(n, 2 / 3))));
  const colunas = Math.ceil(Math.sqrt(porCamada));
  const linhas = Math.ceil(porCamada / colunas);
  for (let i = 0; i < n; i++) {
    const camada = Math.floor(i / porCamada);
    const k = i % porCamada;
    const x = ((k % colunas) - (colunas - 1) / 2) * tam.x * folga;
    const z = (Math.floor(k / colunas) - (linhas - 1) / 2) * tam.z * folga;
    const m = new THREE.Matrix4().makeTranslation(x, camada * tam.y, z);
    // Camadas alternadas giram meia volta, como numa pilha de verdade.
    if (camada % 2 === 1) m.multiply(new THREE.Matrix4().makeRotationY(Math.PI));
    r.push(m);
  }
  return r;
}

/** Peça repetida n vezes. Usa InstancedMesh: centenas de blocos custam como um só. */
/**
 * Pilha de peças. `cair(desde)` devolve o quadro da animação em que as peças a partir de `desde`
 * caem uma a uma, na ordem da pilha: 1 saco cai 1; ao passar para 2, cai só o segundo.
 */
type Queda = (desde: number, aoBater?: (mundo: THREE.Vector3, velocidade: number) => void) => { quadro: (t: number) => void; segundos: number } | null;

function montarPilha(modelo: THREE.Object3D, n: number, arranjo: string, mat: { e: number; macio: boolean }): { grupo: THREE.Group; cair: Queda } {
  const grupo = new THREE.Group();
  const tam = caixa(modelo).getSize(new THREE.Vector3());
  const posicoes = posicoesPilha(n, tam, arranjo);
  // Empilhado à mão: cada peça fica alguns milímetros fora do lugar e levemente girada.
  if (arranjo !== "feixe") posicoes.forEach((m, k) => {
    const f = Math.min(tam.x, tam.z);
    m.premultiply(new THREE.Matrix4().makeTranslation((acaso(k, 11) - 0.5) * f * 0.05, 0, (acaso(k, 12) - 0.5) * f * 0.05));
    m.multiply(new THREE.Matrix4().makeRotationY((acaso(k, 13) - 0.5) * 0.07));
  });
  let temInstancias = false;
  modelo.updateMatrixWorld(true);
  modelo.traverse((o) => { if ((o as THREE.InstancedMesh).isInstancedMesh) temInstancias = true; });

  // Cada peça é posta por uma função que recebe a matriz final (ou null para esconder).
  let por: (i: number, m: THREE.Matrix4 | null) => void;
  let fechar = () => {};
  if (temInstancias) {
    // Modelos com instâncias próprias (brita, pregos) são clonados inteiros.
    const clones = posicoes.map((p) => {
      const c = modelo.clone(true);
      c.matrixAutoUpdate = false;
      c.matrix.copy(p);
      grupo.add(c);
      return c;
    });
    por = (i, m) => { const c = clones[i]; c.visible = !!m; if (m) c.matrix.copy(m); c.matrixWorldNeedsUpdate = true; };
  } else {
    const malhas: { malha: THREE.InstancedMesh; local: THREE.Matrix4 }[] = [];
    modelo.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const inst = new THREE.InstancedMesh(m.geometry, m.material, posicoes.length);
      inst.castShadow = true; inst.receiveShadow = true;
      const local = m.matrixWorld.clone();
      posicoes.forEach((p, k) => inst.setMatrixAt(k, p.clone().multiply(local)));
      inst.instanceMatrix.needsUpdate = true;
      inst.computeBoundingSphere();
      inst.computeBoundingBox();
      grupo.add(inst);
      malhas.push({ malha: inst, local });
    });
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    por = (i, m) => { for (const { malha, local } of malhas) malha.setMatrixAt(i, m ? m.clone().multiply(local) : zero); };
    fechar = () => { for (const { malha } of malhas) malha.instanceMatrix.needsUpdate = true; };
  }

  // Queda com gravidade real: tempo de queda, velocidade de impacto e quiques saem de g = 9,81 m/s².
  const h0 = Math.max(1.4, Math.min(3, tam.y * 5));
  const centro = caixa(modelo).getCenter(new THREE.Vector3());
  /**
   * Peça rígida com simulação de corpos rígidos: cada uma é solta inclinada acima do seu lugar,
   * bate, tomba, escorrega sobre as outras e assenta. No fim, acomoda na posição da pilha.
   */
  const cairFisica = (desde: number, aoBater?: (mundo: THREE.Vector3, velocidade: number) => void) => {
    const novas = posicoes.length - desde;
    const intervalo = Math.min(0.3, 2.4 / novas);
    const assentar = 2.4, acomodar = 0.5;
    const total = intervalo * (novas - 1) + assentar + acomodar;
    const meio = new CANNON.Vec3(Math.max(0.005, tam.x / 2), Math.max(0.005, tam.y / 2), Math.max(0.005, tam.z / 2));
    const alvoP: THREE.Vector3[] = [], alvoQ: THREE.Quaternion[] = [];
    for (const m of posicoes) {
      const q = new THREE.Quaternion().setFromRotationMatrix(m);
      alvoQ.push(q);
      alvoP.push(centro.clone().applyMatrix4(m));
    }
    let mundo: CANNON.World | null = null;
    let corpos: (CANNON.Body | null)[] = [];
    let relogio = 0;
    const bateu = new Set<number>();
    const iniciar = () => {
      mundo = new CANNON.World({ gravity: new CANNON.Vec3(0, -G, 0) });
      mundo.allowSleep = true;
      (mundo.solver as CANNON.GSSolver).iterations = 14;
      mundo.defaultContactMaterial.friction = arranjo === "feixe" ? 0.35 : 0.6;
      mundo.defaultContactMaterial.restitution = mat.e;
      mundo.addBody(new CANNON.Body({ type: CANNON.Body.STATIC, shape: new CANNON.Plane(), quaternion: new CANNON.Quaternion().setFromEuler(-Math.PI / 2, 0, 0) }));
      // As peças que já estavam na pilha ficam paradas e servem de apoio.
      for (let k = 0; k < desde; k++) {
        const b = new CANNON.Body({ type: CANNON.Body.STATIC, shape: new CANNON.Box(meio) });
        b.position.set(alvoP[k].x, alvoP[k].y, alvoP[k].z);
        b.quaternion.set(alvoQ[k].x, alvoQ[k].y, alvoQ[k].z, alvoQ[k].w);
        mundo.addBody(b);
      }
      corpos = posicoes.map(() => null);
      relogio = 0;
      bateu.clear();
    };
    const soltar = (k: number) => {
      const b = new CANNON.Body({ mass: Math.max(0.2, tam.x * tam.y * tam.z * 1800), shape: new CANNON.Box(meio), sleepSpeedLimit: 0.12, sleepTimeLimit: 0.4, linearDamping: 0.02, angularDamping: 0.08 });
      const h = Math.max(0.35, Math.min(1.1, tam.y * 4)) * (0.8 + 0.4 * acaso(k, 1));
      const menor = Math.min(tam.x, tam.z);
      b.position.set(alvoP[k].x + (acaso(k, 5) - 0.5) * menor * 0.12, alvoP[k].y + h, alvoP[k].z + (acaso(k, 6) - 0.5) * menor * 0.12);
      const inclina = new THREE.Quaternion().setFromEuler(new THREE.Euler((acaso(k, 2) - 0.5) * 0.5, (acaso(k, 3) - 0.5) * 0.3, (acaso(k, 4) - 0.5) * 0.5));
      const q = alvoQ[k].clone().multiply(inclina);
      b.quaternion.set(q.x, q.y, q.z, q.w);
      b.angularVelocity.set((acaso(k, 7) - 0.5) * 1.6, (acaso(k, 8) - 0.5) * 0.8, (acaso(k, 9) - 0.5) * 1.6);
      b.addEventListener("collide", (ev: { contact: CANNON.ContactEquation }) => {
        if (bateu.has(k)) return;
        bateu.add(k);
        if (aoBater) aoBater(grupo.localToWorld(new THREE.Vector3(b.position.x, b.position.y - tam.y / 2, b.position.z)), Math.abs(ev.contact.getImpactVelocityAlongNormal()));
      });
      mundo!.addBody(b);
      corpos[k] = b;
    };
    const P = new THREE.Vector3(), Q = new THREE.Quaternion(), M = new THREE.Matrix4(), UM = new THREE.Vector3(1, 1, 1);
    const volta = new THREE.Matrix4().makeTranslation(-centro.x, -centro.y, -centro.z);
    const quadro = (t: number) => {
      if (t >= 1) { for (let k = desde; k < posicoes.length; k++) por(k, posicoes[k]); fechar(); mundo = null; return; }
      if (!mundo || t === 0) iniciar();
      const agora = t * total;
      // Passo fixo; se o quadro atrasar, a simulação alcança aos poucos.
      let passos = 0;
      while (relogio < agora && passos < 30) {
        for (let k = desde; k < posicoes.length; k++) if (!corpos[k] && relogio >= (k - desde) * intervalo) soltar(k);
        mundo!.step(1 / 120);
        relogio += 1 / 120;
        passos++;
      }
      const fim = Math.max(0, Math.min(1, (agora - (total - acomodar)) / acomodar));
      const s = fim * fim * (3 - 2 * fim);
      for (let k = desde; k < posicoes.length; k++) {
        const b = corpos[k];
        if (!b) { por(k, null); continue; }
        P.set(b.position.x, b.position.y, b.position.z);
        Q.set(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w);
        if (s > 0) { P.lerp(alvoP[k], s); Q.slerp(alvoQ[k], s); }
        por(k, M.compose(P, Q, UM).multiply(volta));
      }
      fechar();
    };
    return { quadro, segundos: total };
  };

  const cair = (desde: number, aoBater?: (mundo: THREE.Vector3, velocidade: number) => void) => {
    const novas = posicoes.length - desde;
    if (novas <= 0) return null;
    if (!mat.macio && novas <= 70) return cairFisica(desde, aoBater);
    const intervalo = Math.min(0.32, 2 / novas);
    const dados = posicoes.map((_, k) => {
      const h = h0 * (0.85 + 0.35 * acaso(k, 1));
      const tq = Math.sqrt((2 * h) / G), v = G * tq;
      return {
        h, tq, v, b1: (2 * v * mat.e) / G, b2: (2 * v * mat.e * mat.e) / G,
        rot: new THREE.Euler((acaso(k, 2) - 0.5) * 0.7, (acaso(k, 3) - 0.5) * 1.0, (acaso(k, 4) - 0.5) * 0.7),
        dx: (acaso(k, 5) - 0.5) * 0.22, dz: (acaso(k, 6) - 0.5) * 0.22,
      };
    });
    const total = intervalo * (novas - 1) + Math.max(...dados.slice(desde).map((d) => d.tq + d.b1 + d.b2)) + 0.3;
    const bateu = new Set<number>();
    const T = new THREE.Matrix4(), R = new THREE.Matrix4(), S = new THREE.Matrix4(), e = new THREE.Euler();
    const quadro = (t: number) => {
      const agora = t * total;
      if (t === 0) bateu.clear();
      for (let k = desde; k < posicoes.length; k++) {
        const d = dados[k];
        const tau = agora - (k - desde) * intervalo;
        if (t >= 1) { por(k, posicoes[k]); continue; }
        if (tau <= 0) { por(k, null); continue; }
        let y = 0, solto = 0, amassa = 1;
        if (tau < d.tq) {
          y = d.h - (G * tau * tau) / 2;
          solto = 1 - (tau / d.tq) ** 2;
        } else {
          const u = tau - d.tq;
          if (!bateu.has(k)) {
            bateu.add(k);
            if (aoBater) aoBater(grupo.localToWorld(new THREE.Vector3().setFromMatrixPosition(posicoes[k])), d.v);
          }
          if (u < d.b1) y = d.v * mat.e * u - (G * u * u) / 2;
          else if (u < d.b1 + d.b2) { const w = u - d.b1; y = d.v * mat.e * mat.e * w - (G * w * w) / 2; }
          // Saco e rolo amassam no impacto e voltam; peça rígida só quica.
          if (mat.macio) amassa = 1 - 0.22 * Math.exp(-u * 9) * Math.cos(u * 22);
        }
        // Peça rígida balança um instante depois de bater e assenta.
        const u2 = tau - d.tq;
        const balanco = !mat.macio && u2 > 0 ? 0.16 * Math.exp(-u2 * 5) * Math.cos(u2 * 17) : 0;
        e.set(d.rot.x * (solto + balanco), d.rot.y * solto, d.rot.z * (solto + balanco));
        R.makeRotationFromEuler(e);
        const lado = 1 / Math.sqrt(amassa);
        S.makeScale(lado, amassa, lado);
        por(k, T.makeTranslation(d.dx * solto, Math.max(0, y), d.dz * solto).multiply(posicoes[k]).multiply(R).multiply(S));
      }
      fechar();
    };
    return { quadro, segundos: total };
  };
  return { grupo, cair };
}

/** Etapas de montagem de um kit: cada nó traz etapa_ordem e, às vezes, remover_na_etapa. */
function aplicarEtapa(kit: THREE.Object3D, etapa: number, progresso = 1) {
  kit.traverse((o) => {
    const d = o.userData as { etapa_ordem?: number; remover_na_etapa?: number; _y?: number };
    if (d.etapa_ordem == null) return;
    if (d._y == null) d._y = o.position.y;
    const removida = d.remover_na_etapa != null && etapa >= d.remover_na_etapa;
    o.visible = d.etapa_ordem <= etapa && !removida;
    o.position.y = d._y + (d.etapa_ordem === etapa ? (1 - suave(progresso)) * 0.35 : 0);
  });
}
function etapasDoKit(kit: THREE.Object3D) {
  let max = 0;
  kit.traverse((o) => { const e = (o.userData as { etapa_ordem?: number }).etapa_ordem; if (e != null && e > max) max = e; });
  return max;
}

const corpo = (g: THREE.Object3D) => (g.userData.corpo as THREE.Group | undefined) ?? (g as THREE.Group);

// Equipe com roupa de obra: pele, camisa, calça, bota e capacete branco; o colete fica laranja.
const ROUPA: [RegExp, number, number][] = [
  [/_(cabeca|pescoco)$/, 0xb98a68, 0.75],
  [/_(tronco|ombro[DE]|braco[DE]|antebraco[DE])$/, 0x7d8a94, 0.9],
  [/_(quadril|coxa[DE]|canela[DE])$/, 0x2c3646, 0.9],
  [/_bota[DE]$/, 0x3b2c21, 0.8],
  [/_luva[DE]$/, 0xc2a476, 0.85],
  [/_capacete(_aba|_friso)?$/, 0xf1f0ea, 0.45],
];
const matRoupa = new Map<number, THREE.MeshStandardMaterial>();
function vestir(figura: THREE.Object3D) {
  figura.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const nome = o.name.replace(/[._]\d+$/, "");
    if (/_fer[DE]_/.test(nome)) return;
    const regra = ROUPA.find(([re]) => re.test(nome));
    if (!regra) return;
    m.material = roupa(regra[1], regra[2]);
  });
}
function roupa(cor: number, rugosidade: number) {
  let mat = matRoupa.get(cor);
  if (!mat) { mat = new THREE.MeshStandardMaterial({ color: cor, roughness: rugosidade, metalness: 0 }); matRoupa.set(cor, mat); }
  return mat;
}
/** Mesma roupa na figura animada, que vem sem o nome das partes: decide pela altura e pelo tamanho de cada malha. */
function vestirGesto(figura: THREE.Object3D) {
  figura.updateMatrixWorld(true);
  const total = caixa(figura);
  const H = Math.max(0.5, total.max.y - total.min.y);
  figura.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || Array.isArray(m.material)) return;
    const nome = m.material.name;
    const bb = new THREE.Box3().setFromObject(m);
    const t = bb.getSize(new THREE.Vector3());
    const alto = ((bb.min.y + bb.max.y) / 2 - total.min.y) / H;
    if (nome.startsWith("Anel de horas")) { m.visible = false; return; }
    if (nome.startsWith("Manequim")) m.material = alto > 0.84 ? roupa(0xb98a68, 0.75) : alto < 0.5 ? roupa(0x2c3646, 0.9) : roupa(0x7d8a94, 0.9);
    else if (nome.startsWith("EPI laranja")) {
      if (t.y < 0.04 && alto < 0.08) m.visible = false;                        // segmento do anel de horas
      else if (alto > 0.88) m.material = roupa(0xf1f0ea, 0.45);                // capacete
      else if (alto < 0.12) m.material = roupa(0x3b2c21, 0.8);                 // bota
      else if (Math.max(t.x, t.y, t.z) < 0.24) m.material = roupa(0xc2a476, 0.85); // luva
    }
  });
}

function acenderAnel(figura: THREE.Object3D, segmentos: number) {
  figura.traverse((o) => {
    const m = o.name.match(/_anel_h(\d{2})$/);
    if (m) o.visible = Number(m[1]) < segmentos;
  });
}

// ---------------------------------------------------------------------------
// Motor
// ---------------------------------------------------------------------------
export class Motor {
  private renderer: THREE.WebGLRenderer;
  private rotulos: CSS2DRenderer;
  private ultimaArrumacao = 0;
  private areas = new THREE.Group();
  private patio: { x0: number; x1: number; z0: number; z1: number } | null = null;
  /** Depósito por item: entradas que dividem a mesma área, pela chave de cada entrada. */
  private vizinhas = new Map<string, string[]>();
  private cena = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controles: OrbitControls;
  private relogio = new THREE.Timer();
  private mixers = new Set<THREE.AnimationMixer>();
  private tarefas = new Set<Tarefa>();
  private estacoes = new Map<string, Estacao>();
  private raiz = new THREE.Group();
  private chao: THREE.Mesh;
  private ceu = new Sky();
  private pmrem: THREE.PMREMGenerator;
  private hemisferio = new THREE.HemisphereLight(0xdff3f6, 0x6b5a45, 0.35);
  private direcaoSol = new THREE.Vector3(0.4, 0.75, 0.5);
  private grao: THREE.CanvasTexture;
  private texConcreto: THREE.Texture;
  /** Árvores em volta do pátio; ficam fora da raiz para não entrar no enquadramento nem nas medidas. */
  private acabamentos = new Map<Acabamento, ReturnType<typeof texturaAcabamento>>();
  private compositor: EffectComposer | null = null;
  private sol: THREE.DirectionalLight;
  private quadro = 0;
  private visivel = true;
  private observador: ResizeObserver;
  private versao = 0;
  private opcoes: Opcoes;
  private ultimoModo: ModoCena = "canteiro";
  private visuais = new Map<string, Visual>();
  private filtro: Filtro = null;
  private oclusao: GTAOPass | null = null;
  private gestos: { mixer: THREE.AnimationMixer; cena: THREE.Object3D }[] = [];
  /** Qualidade automática: 0 completa, 1 sem oclusão, 2 também com menos pixels e sombra menor. */
  private nivel = 0;
  private amostra = { desde: 0, quadros: 0 };
  private vistaAtual: Vista = "perspectiva";
  private realce = new THREE.Box3Helper(new THREE.Box3(), 0xf28c28);
  private apontado: string | null = null;
  private selecao = new THREE.Box3Helper(new THREE.Box3(), 0x0f6c7a);
  private ultimoApontar = 0;
  private medindo = false;
  private pontos: THREE.Vector3[] = [];
  private medida = new THREE.Group();
  private custos = new THREE.Group();
  private porCusto = false;
  /** Teclas de andar (WASD e setas) que estão apertadas, e se o ponteiro está sobre a cena. */
  private teclas = new Set<string>();
  private sobreCena = false;

  constructor(private container: HTMLElement, opcoes: Opcoes) {
    this.opcoes = opcoes;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.9;
    this.renderer.setClearColor(0x000000, 0);
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.className = "v3d-canvas";

    this.rotulos = new CSS2DRenderer();
    this.rotulos.domElement.className = "v3d-rotulos";
    container.appendChild(this.rotulos.domElement);

    this.camera = new THREE.PerspectiveCamera(38, 1, 0.15, 2000);
    this.camera.position.set(4, 3, 6);
    this.controles = new OrbitControls(this.camera, this.renderer.domElement);
    this.controles.enableDamping = true;
    // Câmera toda no mouse: esquerdo ou botão do meio giram, direito arrasta, rolagem aproxima onde o ponteiro está.
    this.controles.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.PAN };
    this.controles.zoomToCursor = true;
    this.controles.zoomSpeed = 1.2;
    this.controles.dampingFactor = 0.12;
    // O botão do meio não abre a rolagem automática do navegador.
    this.renderer.domElement.addEventListener("mousedown", (e) => { if (e.button === 1) e.preventDefault(); });
    this.controles.maxPolarAngle = Math.PI * 0.49;
    this.controles.minDistance = 0.4;
    this.controles.maxDistance = 400;

    this.grao = grao();
    // Texturas escaneadas (cor, relevo e rugosidade) para o terreno, os pisos e os suportes.
    const anis = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    const tl = new THREE.TextureLoader();
    const tex = (nome: string, cor = false) => {
      const t = tl.load(`${CAMINHO_TERRENO}/${nome}.webp`);
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      if (cor) t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = anis;
      return t;
    };
    this.texConcreto = tex("piso_cor", true);
    if (!MAT_MADEIRA.map) { MAT_MADEIRA.map = tex("madeira_cor", true); MAT_MADEIRA.normalMap = tex("madeira_normal"); MAT_MADEIRA.color.set(0xffffff); MAT_MADEIRA.needsUpdate = true; }
    if (!MAT_CONCRETO.map) { MAT_CONCRETO.map = tex("concreto_cor", true); MAT_CONCRETO.normalMap = tex("concreto_normal"); MAT_CONCRETO.color.set(0xffffff); MAT_CONCRETO.needsUpdate = true; }

    // Céu físico (espalhamento atmosférico); a luz ambiente da cena vem dele.
    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.ceu.scale.setScalar(1500);
    this.cena.add(this.hemisferio);
    this.sol = new THREE.DirectionalLight(0xfff3dc, 3);
    this.sol.castShadow = true;
    this.sol.shadow.mapSize.set(2048, 2048);
    this.sol.shadow.bias = -0.0006;
    this.sol.shadow.normalBias = 0.05;
    this.sol.shadow.radius = 3;
    this.cena.add(this.sol, this.sol.target);

    // Fundo neutro: o chão só recebe as sombras, sem terreno nem horizonte.
    this.chao = new THREE.Mesh(new THREE.CircleGeometry(700, 48), new THREE.ShadowMaterial({ opacity: 0.22, fog: false }));
    this.chao.rotation.x = -Math.PI / 2;
    this.chao.position.y = -0.14;
    this.chao.receiveShadow = true;
    this.cena.add(this.chao);
    this.cena.fog = new THREE.Fog(0xe8edf0, 90, 650);
    this.aplicarTema(opcoes.escuro);

    // Oclusão de ambiente: escurece cantos e contatos, o que assenta as peças no chão.
    try {
      const alvo = new THREE.WebGLRenderTarget(1, 1, { samples: 4, type: THREE.HalfFloatType });
      const comp = new EffectComposer(this.renderer, alvo);
      comp.addPass(new RenderPass(this.cena, this.camera));
      const ao = new GTAOPass(this.cena, this.camera, 1, 1);
      ao.updateGtaoMaterial({ radius: 0.45, distanceExponent: 1.2, thickness: 1, scale: 1.15, samples: 12, screenSpaceRadius: false });
      ao.blendIntensity = 0.85;
      comp.addPass(ao);
      this.oclusao = ao;
      comp.addPass(new OutputPass());
      this.compositor = comp;
    } catch { this.compositor = null; }
    this.cena.add(this.raiz);
    this.realce.visible = false;
    this.medida.renderOrder = 10;
    this.selecao.visible = false;
    this.cena.add(this.realce, this.selecao, this.medida, this.custos);
    this.renderer.domElement.addEventListener("pointermove", this.aoMover);
    this.renderer.domElement.addEventListener("pointerleave", this.aoSair);

    this.renderer.domElement.addEventListener("pointerdown", this.aoApertar);
    this.renderer.domElement.addEventListener("pointerup", this.aoSoltar);
    container.addEventListener("pointerenter", this.aoEntrar);
    container.addEventListener("pointerleave", this.aoDeixar);
    window.addEventListener("keydown", this.aoTeclar);
    window.addEventListener("keyup", this.aoSoltarTecla);
    window.addEventListener("blur", this.aoDeixar);
    this.observador = new ResizeObserver(() => this.redimensionar());
    this.observador.observe(container);
    this.redimensionar();
    this.laco();
  }

  /** Claro: sol alto de manhã. Escuro: fim de tarde, sol baixo e luz quente. */
  aplicarTema(escuro: boolean) {
    this.opcoes.escuro = escuro;
    const elev = THREE.MathUtils.degToRad(escuro ? 9 : 38), azim = THREE.MathUtils.degToRad(35);
    this.direcaoSol.set(Math.sin(azim) * Math.cos(elev), Math.sin(elev), Math.cos(azim) * Math.cos(elev));
    const u = this.ceu.material.uniforms;
    u.turbidity.value = escuro ? 8 : 5;
    u.rayleigh.value = escuro ? 2.6 : 1.4;
    u.mieCoefficient.value = 0.005;
    u.mieDirectionalG.value = 0.8;
    u.sunPosition.value.copy(this.direcaoSol);
    this.sol.color.set(escuro ? 0xffa25e : 0xfff3dc);
    this.sol.intensity = escuro ? 3.4 : 5.5;
    this.hemisferio.intensity = escuro ? 0.12 : 0.2;
    this.renderer.toneMappingExposure = escuro ? 0.55 : 0.5;
    const fundo = escuro ? 0x16262c : 0xe8edf0;
    (this.cena.fog as THREE.Fog).color.set(fundo);
    this.cena.background = new THREE.Color(fundo);
    // Ambiente a partir do próprio céu.
    const temp = new THREE.Scene();
    temp.add(this.ceu);
    const antigo = this.cena.environment;
    this.cena.environment = this.pmrem.fromScene(temp, 0.02).texture;
    this.cena.environmentIntensity = escuro ? 0.3 : 0.22;
    antigo?.dispose();
    this.posicionarSol();
  }

  private alcanceSol = 12;
  private posicionarSol() {
    this.sol.position.copy(this.direcaoSol).multiplyScalar(this.alcanceSol * 2.5);
    this.sol.target.position.set(0, 0, 0);
  }

  definirAnimacoes(ligadas: boolean) { this.opcoes.animacoes = ligadas; }

  private aoApertar = (e: PointerEvent) => { (this as unknown as { _xy: [number, number] })._xy = [e.clientX, e.clientY]; };
  private pegar(e: PointerEvent, comChao = false) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const p = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(p, this.camera);
    const hit = ray.intersectObjects(comChao ? [this.raiz, this.chao] : [this.raiz], true).find((h) => h.object.visible && !h.object.userData.fantasma);
    let o: THREE.Object3D | null = hit?.object ?? null;
    const ordem = (hit?.object.userData.ordemIfc as number | undefined) ?? null;
    while (o && !o.userData.itemId) o = o.parent;
    return { id: (o?.userData.itemId as string | undefined) ?? null, ordem, ponto: hit?.point ?? null, x: e.clientX - r.left, y: e.clientY - r.top };
  }

  // Andar pela cena com WASD ou setas, enquanto o ponteiro está sobre ela e ninguém está digitando.
  private aoEntrar = () => { this.sobreCena = true; };
  private aoDeixar = () => { this.sobreCena = false; this.teclas.clear(); };
  private teclaDeAndar(e: KeyboardEvent): string | null {
    if (e.ctrlKey || e.metaKey || e.altKey) return null;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    return ({ w: "frente", ArrowUp: "frente", s: "tras", ArrowDown: "tras", a: "esquerda", ArrowLeft: "esquerda", d: "direita", ArrowRight: "direita" } as Record<string, string>)[k] ?? null;
  }
  private aoTeclar = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    if (!this.sobreCena || (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)))) return;
    const d = this.teclaDeAndar(e);
    if (!d) return;
    e.preventDefault(); // as setas não rolam a página enquanto movem a câmera
    this.teclas.add(d);
  };
  private aoSoltarTecla = (e: KeyboardEvent) => { const d = this.teclaDeAndar(e); if (d) this.teclas.delete(d); };
  private andar(dt: number) {
    if (!this.teclas.size) return;
    const frente = new THREE.Vector3().subVectors(this.controles.target, this.camera.position);
    const dist = frente.length();
    frente.y = 0;
    if (frente.lengthSq() < 1e-6) frente.set(0, 0, -1); // de cima (planta): "frente" é o alto da tela
    frente.normalize();
    const lado = new THREE.Vector3(-frente.z, 0, frente.x);
    const passo = new THREE.Vector3();
    if (this.teclas.has("frente")) passo.add(frente);
    if (this.teclas.has("tras")) passo.sub(frente);
    if (this.teclas.has("direita")) passo.add(lado);
    if (this.teclas.has("esquerda")) passo.sub(lado);
    if (passo.lengthSq() === 0) return;
    // Velocidade proporcional à distância: perto anda devagar, de longe atravessa o canteiro.
    passo.normalize().multiplyScalar(THREE.MathUtils.clamp(dist * 0.9, 1.2, 60) * dt);
    this.camera.position.add(passo);
    this.controles.target.add(passo);
  }

  private aoSoltar = (e: PointerEvent) => {
    const xy = (this as unknown as { _xy?: [number, number] })._xy;
    if (!xy || Math.hypot(e.clientX - xy[0], e.clientY - xy[1]) > 5) return;
    if (this.medindo) {
      const { ponto } = this.pegar(e, true);
      if (ponto) { this.pontos.push(ponto.clone()); this.desenharMedida(); }
      return;
    }
    const { id, ordem } = this.pegar(e);
    if (ordem != null) {
      // Projeto IFC: cada clique passa ao próximo item lançado a partir do mesmo grupo.
      const itens = this.malhasProjeto.find((x) => x.ordem === ordem)?.itens ?? [];
      if (itens.length) this.opcoes.onSelecionar?.(itens[(itens.indexOf(this.focoProjeto ?? "") + 1) % itens.length]);
      return;
    }
    if (id) this.opcoes.onSelecionar?.(id);
  };

  /** Passar o mouse: contorna o elemento e avisa a tela, que mostra o cartão com os dados do orçamento. */
  private aoMover = (e: PointerEvent) => {
    const agora = performance.now();
    if (e.buttons || agora - this.ultimoApontar < 50) return;
    this.ultimoApontar = agora;
    const { id, ordem, x, y } = this.pegar(e);
    if (ordem != null && !this.medindo) {
      const alvo = this.malhasProjeto.find((m) => m.ordem === ordem);
      this.renderer.domElement.style.cursor = alvo?.itens.length ? "pointer" : "";
      if (alvo && this.apontadoIfc !== ordem) {
        this.apontado = null;
        this.apontadoIfc = ordem;
        this.realce.box.copy(caixa(alvo.malha));
        this.realce.visible = true;
      }
      this.opcoes.onApontarProjeto?.({ ordem, x, y });
      return;
    }
    if (this.apontadoIfc != null) { this.apontadoIfc = null; this.realce.visible = false; this.opcoes.onApontarProjeto?.(null); }
    const est = id ? this.estacoes.get(id) : null;
    this.renderer.domElement.style.cursor = this.medindo ? "crosshair" : est && this.ultimoModo !== "item" ? "pointer" : "";
    if (!est || this.medindo) { this.aoSair(); return; }
    if (this.apontado !== id) {
      this.apontado = id;
      // Só o que está à vista entra na moldura; com um serviço sozinho na tela ela não ajuda.
      this.realce.box.copy(caixaVisivel(est.grupo));
      this.realce.visible = this.ultimoModo !== "item" && !this.realce.box.isEmpty();
    }
    this.opcoes.onApontar?.({ itemId: est.itemId, x, y });
  };
  private aoSair = () => {
    if (this.apontadoIfc != null) { this.apontadoIfc = null; this.opcoes.onApontarProjeto?.(null); }
    if (!this.apontado && !this.realce.visible) return;
    this.apontado = null;
    this.realce.visible = false;
    this.opcoes.onApontar?.(null);
  };

  private redimensionar() {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.compositor?.setPixelRatio(this.renderer.getPixelRatio());
    this.compositor?.setSize(w, h);
    this.rotulos.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private laco = () => {
    this.quadro = requestAnimationFrame(this.laco);
    if (!this.visivel) return;
    this.relogio.update();
    const dt = Math.min(0.05, this.relogio.getDelta());
    const agora = performance.now();
    for (const m of this.mixers) m.update(dt);
    if (this.gestos.length) {
      // Figura que saiu da cena leva o gesto junto.
      this.gestos = this.gestos.filter((x) => { let o: THREE.Object3D | null = x.cena; while (o && o !== this.cena) o = o.parent; return !!o; });
      for (const x of this.gestos) x.mixer.update(dt);
    }
    for (const t of this.tarefas) {
      const f = Math.min(1, (agora - t.inicio) / t.duracao);
      t.passo(f);
      if (f >= 1) { this.tarefas.delete(t); t.fim?.(); }
    }
    this.medirDesempenho(agora);
    this.andar(dt);
    this.controles.update();
    if (this.compositor && this.nivel < 2) this.compositor.render(); else this.renderer.render(this.cena, this.camera);
    this.rotulos.render(this.cena, this.camera);
    if (agora - this.ultimaArrumacao > 160) { this.ultimaArrumacao = agora; this.arrumarRotulos(); }
  };

  /** Em computador mais simples a cena abre mão primeiro da oclusão, depois de resolução, e segue fluida. */
  private medirDesempenho(agora: number) {
    const a = this.amostra;
    if (!a.desde) { a.desde = agora; a.quadros = 0; return; }
    a.quadros++;
    if (agora - a.desde < 2500) return;
    const fps = (a.quadros * 1000) / (agora - a.desde);
    a.desde = agora; a.quadros = 0;
    if (fps >= 26 || this.nivel >= 2 || this.tarefas.size) return;
    this.nivel++;
    if (this.oclusao) this.oclusao.enabled = false;
    if (this.nivel === 2) {
      this.renderer.setPixelRatio(1);
      this.sol.shadow.mapSize.set(1024, 1024);
      this.sol.shadow.map?.dispose();
      this.sol.shadow.map = null;
      this.redimensionar();
    }
  }

  /** Esconde rótulos que cairiam em cima de outro já visível; o item escolhido tem prioridade. */
  private arrumarRotulos() {
    const els = [...this.rotulos.domElement.querySelectorAll<HTMLElement>(".v3d-marcador, .v3d-rotulo, .v3d-area-titulo")];
    if (els.length < 2) return;
    const peso = (el: HTMLElement) => el.classList.contains("v3d-area-titulo") ? 0 : el.classList.contains("v3d-marcador-ativo") ? 1 : 2;
    els.sort((x, y) => peso(x) - peso(y));
    const ocupados: DOMRect[] = [];
    for (const el of els) {
      if (el.style.display === "none") continue;
      el.classList.remove("v3d-oculto");
      const r = el.getBoundingClientRect();
      const bate = ocupados.some((o) => r.left < o.right + 2 && r.right > o.left - 2 && r.top < o.bottom + 2 && r.bottom > o.top - 2);
      if (bate) el.classList.add("v3d-oculto"); else ocupados.push(r);
    }
  }

  definirVisivel(v: boolean) { this.visivel = v; this.amostra.desde = 0; if (v) this.relogio.reset(); }

  private tarefa(duracao: number, passo: (t: number) => void, fim?: () => void) {
    const t: Tarefa = { inicio: performance.now(), duracao, passo, fim };
    this.tarefas.add(t);
    passo(0);
    return t;
  }

  // -------------------------------------------------------------------------
  // Cena
  // -------------------------------------------------------------------------
  /**
   * Monta (ou atualiza) a cena. Itens que já estavam na tela e não mudaram ficam como estão;
   * os que mudaram de quantidade crescem ou encolhem; os de `animar` tocam a animação de entrada.
   */
  /**
   * Obra construída: cada local vira um elemento em escala real, com as partes ligadas aos itens do orçamento.
   * `custos` traz o custo direto de cada item, para o cartão e a visualização por custo.
   */
  definirObra(locais: LocalObra[], custos: Record<string, number>, o: { foco?: string | null } = {}) {
    ++this.versao;
    const recomecar = this.ultimoModo !== "obra";
    this.ultimoModo = "obra";
    this.limpar();
    this.limparAreas();
    this.patio = null;
    this.raiz.position.set(0, 0, 0);
    this.raiz.updateMatrixWorld(true);

    let z = 0;
    for (const local of locais) {
      const meio = z - local.profundidade / 2;
      // Calçada de concreto sob o elemento, para assentar a obra no terreno.
      const borda = 0.6;
      const calcada = new THREE.Mesh(new THREE.BoxGeometry(local.comprimento + borda * 2 + 0.2, 0.05, local.profundidade + borda * 2), new THREE.MeshStandardMaterial({ map: this.texturaEscalada(this.texConcreto, (local.comprimento + 1.4) / 3, (local.profundidade + 1.2) / 3), roughness: 0.95 }));
      calcada.position.set(0, 0.025, meio);
      calcada.receiveShadow = true;
      this.areas.add(calcada);
      const titulo = document.createElement("div");
      titulo.className = "v3d-area-titulo";
      titulo.textContent = local.nome;
      const t = new CSS2DObject(titulo);
      t.position.set(-local.comprimento / 2, local.altura + 0.35, meio);
      t.center.set(0, 1);
      this.areas.add(t);

      for (const p of local.partes) {
        let e = this.estacoes.get(p.itemId);
        if (!e) {
          const grupo = new THREE.Group();
          grupo.userData.itemId = p.itemId;
          const peca = { papel: "kit", custo: custos[p.itemId] ?? null } as Peca;
          e = { itemId: p.itemId, grupo, pecas: [{ peca, grupo, chave: "obra" }] };
          this.estacoes.set(p.itemId, e);
          this.raiz.add(grupo);
        }
        let a = this.acabamentos.get(p.acabamento);
        if (!a) { a = texturaAcabamento(p.acabamento); this.acabamentos.set(p.acabamento, a); }
        const [w, h, d] = p.tam;
        const geo = new THREE.BoxGeometry(w, h, d);
        // Textura por metro: a face maior define a repetição.
        const deitada = h < Math.min(w, d);
        const mapa = this.texturaEscalada(a.mapa, w / a.metro, (deitada ? d : h) / a.metro);
        const mat = new THREE.MeshStandardMaterial({ map: mapa, bumpMap: mapa, bumpScale: a.relevo, roughness: a.rugosidade, metalness: 0 });
        const m = new THREE.Mesh(geo, mat);
        m.position.set(p.pos[0], 0.05 + p.pos[1], meio + p.pos[2]);
        if (p.inclinacao) m.rotation.x = THREE.MathUtils.degToRad(p.inclinacao);
        m.castShadow = true; m.receiveShadow = true;
        e.grupo.add(m);
      }
      z -= local.profundidade + 3.5;
    }
    if (!this.areas.parent) this.raiz.add(this.areas);
    this.centralizarRaiz();
    this.ajustarChao();
    const foco = o.foco && this.estacoes.has(o.foco) ? o.foco : null;
    if (foco) this.focar(foco, recomecar); else { this.focar(""); this.enquadrar(this.raiz, recomecar); }
    this.aplicarFiltro();
    this.desenharCusto();
    this.aoSair();
  }

  // -------------------------------------------------------------------------
  // Projeto IFC
  // -------------------------------------------------------------------------
  private projeto = new THREE.Group();
  private malhasProjeto: MalhaProjeto[] = [];
  private focoProjeto: string | null = null;
  private apontadoIfc: number | null = null;

  private limparProjeto() {
    for (const m of this.malhasProjeto) { m.malha.geometry.dispose(); m.material.dispose(); }
    this.projeto.traverse((o) => { const l = o as THREE.LineSegments; if (l.isLineSegments) { l.geometry.dispose(); (l.material as THREE.Material).dispose(); } });
    this.projeto.clear();
    this.projeto.removeFromParent();
    this.malhasProjeto = [];
    this.focoProjeto = null;
    this.apontadoIfc = null;
  }

  /**
   * Projeto lido do IFC, em escala real. Cada grupo de elementos conhece os itens do orçamento
   * lançados a partir dele: o item escolhido acende os seus elementos; o que ainda não tem item fica cinza.
   */
  definirProjeto(grupos: GrupoProjeto[], o: { foco?: string | null } = {}) {
    ++this.versao;
    const recomecar = this.ultimoModo !== "projeto" || this.malhasProjeto.length !== grupos.length;
    this.ultimoModo = "projeto";
    this.selecao.visible = false;
    if (recomecar) {
      this.limpar();
      this.limparAreas();
      this.patio = null;
      this.raiz.position.set(0, 0, 0);
      let triangulos = 0;
      for (const g of grupos) triangulos += g.indices.length / 3;
      for (const g of grupos) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.BufferAttribute(g.posicoes, 3));
        geo.setIndex(new THREE.BufferAttribute(g.indices, 1));
        geo.computeVertexNormals();
        const alfa = g.cor[3] < 0.99 ? Math.max(0.25, g.cor[3]) : 1;
        const material = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0, side: THREE.DoubleSide, transparent: alfa < 1, opacity: alfa, depthWrite: alfa >= 1 });
        const malha = new THREE.Mesh(geo, material);
        malha.castShadow = alfa >= 1; malha.receiveShadow = true;
        malha.userData.ordemIfc = g.ordem;
        this.projeto.add(malha);
        // Arestas dão a leitura de desenho técnico; em modelos pesados ficam de fora.
        if (triangulos < 600_000 && alfa >= 1) {
          const linhas = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 28), new THREE.LineBasicMaterial({ color: 0x2c3a40, transparent: true, opacity: 0.28 }));
          linhas.raycast = () => undefined;
          malha.add(linhas);
        }
        this.malhasProjeto.push({ ordem: g.ordem, itens: g.itens, malha, material, cor: new THREE.Color().setRGB(g.cor[0], g.cor[1], g.cor[2], THREE.SRGBColorSpace), alfa });
      }
      this.raiz.add(this.projeto);
      this.raiz.updateMatrixWorld(true);
      this.centralizarRaiz();
      this.ajustarChao();
    } else {
      grupos.forEach((g) => { const m = this.malhasProjeto.find((x) => x.ordem === g.ordem); if (m) m.itens = g.itens; });
    }

    const foco = o.foco ?? null;
    const mudou = foco !== this.focoProjeto;
    this.focoProjeto = foco;
    const alvo = new THREE.Box3();
    for (const m of this.malhasProjeto) {
      const doItem = !!foco && m.itens.includes(foco);
      m.material.color.copy(doItem ? COR_SELECAO : m.itens.length ? m.cor : COR_SEM_ITEM);
      m.material.emissive.setHex(doItem ? 0x7a3d00 : 0x000000);
      m.material.emissiveIntensity = doItem ? 0.35 : 0;
      if (doItem) alvo.union(caixa(m.malha));
    }
    if (recomecar) this.enquadrar(this.raiz, true);
    else if (mudou && !alvo.isEmpty()) this.enquadrar(alvo.expandByScalar(1.5), false);
    this.aoSair();
  }

  async definirCena(itens: CenaItem[], modo: ModoCena, o: { foco?: string | null; animar?: Set<string>; montado?: boolean } = {}) {
    const versao = ++this.versao;
    this.selecao.visible = false;
    const leve = modo === "canteiro" && itens.length > 1;
    const recomecar = modo !== this.ultimoModo;
    this.ultimoModo = modo;
    if (recomecar) this.limpar();

    const ids = new Set(itens.map((i) => i.itemId));
    for (const [id, e] of this.estacoes) if (!ids.has(id)) { this.descartar(e); this.estacoes.delete(id); }

    // Só o que acabou de entrar toca a entrada inteira; o que já estava só acrescenta as peças novas.
    const novas = new Set<string>();
    const montadas = await Promise.all(itens.map(async (item) => {
      const pecas = this.pecasVisiveis(item, !!o.montado);
      const anterior = this.estacoes.get(item.itemId);
      const assinatura = pecas.map((p) => this.chave(p, leve)).join(";");
      if (anterior && anterior.grupo.userData.assinatura === assinatura) return anterior;
      if (!anterior) novas.add(item.itemId);
      const est = await this.montarEstacao(item, pecas, leve, modo, anterior);
      est.grupo.userData.assinatura = assinatura;
      return est;
    }));
    if (versao !== this.versao) { montadas.forEach((e) => { if (!this.estacoes.has(e.itemId) || this.estacoes.get(e.itemId) !== e) this.descartar(e); }); return; }

    for (const e of montadas) {
      const ant = this.estacoes.get(e.itemId);
      if (ant && ant !== e) this.descartar(ant);
      this.estacoes.set(e.itemId, e);
      if (!e.grupo.parent) this.raiz.add(e.grupo);
    }
    this.dispor(itens, modo);
    if (versao !== this.versao) return;
    this.centralizarRaiz();
    this.ajustarChao();
    // Enquadra antes de animar: a animação de entrada encolhe ou esconde as peças.
    const foco = o.foco && this.estacoes.has(o.foco) ? o.foco : null;
    if (foco && modo === "canteiro") this.focar(foco, recomecar);
    else this.enquadrar(this.raiz, recomecar || this.estacoes.size <= 1);
    this.aplicarFiltro();
    this.desenharCusto();
    this.aoSair();
    for (const e of montadas) {
      if (o.animar?.has(e.itemId) && novas.has(e.itemId) && this.opcoes.animacoes && !reduzirMovimento()) this.tocarEstacao(e);
    }
  }

  /** Materiais, equipamentos e equipe; o serviço montado (kit) só quando pedido. */
  private pecasVisiveis(item: CenaItem, montado: boolean): Peca[] {
    return montado ? item.pecas : item.pecas.filter((p) => p.papel !== "kit");
  }

  private chave(p: Peca, leve: boolean) {
    return `${p.codigo}${leve ? "~" : ""}:${JSON.stringify(p.visual)}`;
  }

  private async montarEstacao(item: CenaItem, pecas: Peca[], leve: boolean, modo: ModoCena, anterior?: Estacao): Promise<Estacao> {
    const grupo = new THREE.Group();
    grupo.userData.itemId = item.itemId;
    const lista: Estacao["pecas"] = [];
    await Promise.all(pecas.map(async (peca) => {
      try {
        const gltf = await carregar(urlModelo(peca.codigo, leve));
        const g = this.montarPeca(gltf.scene, peca, anterior);
        g.userData.codigo = peca.codigo;
        lista.push({ peca, grupo: g, chave: this.chave(peca, leve) });
      } catch { /* modelo ausente: segue sem ele */ }
    }));
    // Mantém a ordem da cena: kit, materiais, equipamentos, equipe.
    lista.sort((a, b) => pecas.indexOf(a.peca) - pecas.indexOf(b.peca));

    let x = 0;
    const atras: typeof lista = [], frente: typeof lista = [];
    for (const l of lista) (l.peca.papel === "mao_de_obra" ? frente : atras).push(l);
    const fila = (ls: typeof lista, z: number, vao: number) => {
      x = 0;
      const larguras = ls.map((l) => caixa(l.grupo).getSize(new THREE.Vector3()));
      const total = larguras.reduce((s, t) => s + t.x, 0) + Math.max(0, ls.length - 1) * vao;
      x = -total / 2;
      ls.forEach((l, i) => {
        const bb = caixa(l.grupo);
        l.grupo.position.x = x - bb.min.x;
        l.grupo.position.z = z;
        x += larguras[i].x + vao;
        grupo.add(l.grupo);
      });
    };
    if (modo === "item") {
      // Um serviço sozinho: materiais, equipamentos e equipe lado a lado, com folga, sem um ficar na frente do outro.
      const LARGURA = 22;
      const linhas: (typeof lista)[] = [[]];
      let ocupado = 0;
      const medida = new Map(lista.map((l) => [l, caixaVisivel(l.grupo)] as const));
      const vaoDe = (l: (typeof lista)[number]) => (l.peca.papel === "mao_de_obra" ? 1 : 0.6);
      // Ordem de leitura: primeiro os materiais, depois os equipamentos e por fim a equipe.
      const peso = { kit: 0, material: 1, equipamento: 2, mao_de_obra: 3 } as const;
      const ordenada = [...lista].sort((x, y) => peso[x.peca.papel] - peso[y.peca.papel]);
      for (const l of ordenada) {
        const t = medida.get(l)!.getSize(new THREE.Vector3());
        const atual = linhas[linhas.length - 1];
        if (atual.length && ocupado + vaoDe(l) + t.x > LARGURA) { linhas.push([l]); ocupado = t.x; continue; }
        ocupado += (atual.length ? vaoDe(l) : 0) + t.x;
        atual.push(l);
      }
      let z0 = 0;
      for (const linha of linhas) {
        const tams = linha.map((l) => medida.get(l)!.getSize(new THREE.Vector3()));
        const total = tams.reduce((t, v) => t + v.x, 0) + linha.slice(1).reduce((t, l) => t + vaoDe(l), 0);
        const fundo = Math.max(0.6, ...tams.map((t) => t.z));
        let px = -total / 2;
        linha.forEach((l, i) => {
          const bb = medida.get(l)!;
          if (i) px += vaoDe(l);
          l.grupo.position.x = px - bb.min.x;
          // Todos alinhados pela frente da fileira.
          l.grupo.position.z = z0 + fundo - bb.max.z;
          px += tams[i].x;
          grupo.add(l.grupo);
        });
        z0 += fundo + 1.4;
      }
    } else {
    fila(atras, 0, 0.5);
    if (frente.length) {
      const prof = atras.length ? caixa(grupo).max.z : 0;
      // Equipe com mais folga: cada figura leva o próprio rótulo.
      fila(frente, prof + 0.9, 0.6);
    }
    }
    for (const l of lista) {
      if (modo === "item") this.rotular(l.grupo, l.peca);
      l.grupo.userData.itemId = item.itemId;
    }
    return { itemId: item.itemId, grupo, pecas: lista };
  }

  private montarPeca(original: THREE.Object3D, peca: Peca, anterior?: Estacao): THREE.Group {
    const externo = new THREE.Group();
    const g = new THREE.Group();
    externo.add(g);
    externo.userData.corpo = g;
    const v = peca.visual;
    const antes = anterior?.pecas.find((p) => p.peca.codigo === peca.codigo)?.peca.visual;
    const modelo = original.clone(true);
    prepararSombras(modelo);

    if (v.tipo === "monte") {
      g.add(modelo);
      const de = antes?.tipo === "monte" ? antes.escala : v.escala;
      modelo.scale.setScalar(de);
      if (de !== v.escala && this.opcoes.animacoes && !reduzirMovimento()) {
        const b = caixa(modelo).getSize(new THREE.Vector3());
        if (v.escala > de) this.despejar(g, (b.y / de) * v.escala, (Math.max(b.x, b.z) / de) * v.escala / 2, 1500, corDoGranel(peca.origem));
        this.tarefa(1500, (t) => modelo.scale.setScalar(de + (v.escala - de) * suave(t)));
      }
      else modelo.scale.setScalar(v.escala);
    } else if (v.tipo === "pilha") {
      // Restituição do quique pelo material: saco e rolo quase não quicam; aço e madeira quicam mais.
      const macio = /saco|rolo|manta|lona|bobina/i.test(`${peca.rotulo} ${peca.nome}`);
      const { grupo, cair } = montarPilha(modelo, v.visiveis, v.arranjo, { e: macio ? 0.05 : v.arranjo === "feixe" ? 0.3 : 0.2, macio });
      g.add(grupo);
      externo.userData.cair = cair;
      // Quantidade aumentou: só as peças novas caem.
      const desde = antes?.tipo === "pilha" ? Math.min(antes.visiveis, v.visiveis) : v.visiveis;
      this.tocarQueda(externo, desde);
    } else if (v.tipo === "kit") {
      const largura = caixa(modelo).getSize(new THREE.Vector3()).x;
      for (let i = 0; i < v.visiveis; i++) {
        const c = i === 0 ? modelo : modelo.clone(true);
        c.position.x = i * largura;
        g.add(c);
      }
      g.children.forEach((c) => aplicarEtapa(c, Infinity));
    } else if (v.tipo === "figura") {
      vestir(modelo);
      if (v.figuras === 1 && this.nivel < 2 && peca.animado && this.opcoes.animacoes && !reduzirMovimento()) void this.gesto(peca, g, modelo);
      for (let i = 0; i < v.figuras; i++) {
        const c = i === 0 ? modelo : modelo.clone(true);
        c.position.x = i * 0.9;
        acenderAnel(c, i === v.figuras - 1 ? v.segmentos : 24);
        g.add(c);
      }
    } else {
      g.add(modelo);
    }
    return externo;
  }

  private rotular(g: THREE.Group, p: Peca) {
    const el = document.createElement("div");
    el.className = `v3d-rotulo v3d-${p.papel}`;
    const nome = document.createElement("b");
    nome.textContent = p.papel === "mao_de_obra" ? p.nome.split(":")[0] : p.rotulo;
    el.appendChild(nome);
    if (p.papel === "mao_de_obra") {
      const s = document.createElement("span");
      s.textContent = p.rotulo;
      el.appendChild(s);
    }
    const obj = new CSS2DObject(el);
    const bb = caixa(g);
    // Equipe: rótulo aos pés, junto do anel de horas; demais peças: acima.
    const equipe = p.papel === "mao_de_obra";
    obj.position.set((bb.min.x + bb.max.x) / 2 - g.position.x, equipe ? bb.min.y : bb.max.y + 0.08, (bb.min.z + bb.max.z) / 2 - g.position.z);
    obj.center.set(0.5, equipe ? -0.25 : 1);
    g.add(obj);
  }

  /** Canteiro: estações em filas, um bloco de filas por etapa. */
  /**
   * Canteiro arrumado como almoxarifado: uma área demarcada por item do orçamento (ou por etapa,
   * no serviço montado), vagas iguais em grade, cada peça no seu suporte e uma placa no chão
   * com nome, quantidade e valor. No depósito as áreas se distribuem em colunas.
   */
  private dispor(itens: CenaItem[], modo: ModoCena) {
    this.raiz.position.set(0, 0, 0);
    this.raiz.updateMatrixWorld(true); // as medidas abaixo são em coordenadas do mundo
    this.limparAreas();
    this.patio = null;
    for (const e of this.estacoes.values()) this.tirarSuporte(e);
    if (modo === "item") {
      for (const e of this.estacoes.values()) e.grupo.position.set(0, 0, 0);
      this.centralizarRaiz();
      return;
    }
    const porId = new Map(itens.map((i) => [i.itemId, i]));
    const deposito = itens.length > 0 && itens.every((i) => i.itemId.startsWith("dep:"));
    const grupos = new Map<string, { nome: string; ests: Estacao[] }>();
    for (const i of itens) {
      const e = this.estacoes.get(i.itemId);
      if (!e) continue;
      (grupos.get(i.etapaId) ?? grupos.set(i.etapaId, { nome: i.etapa, ests: [] }).get(i.etapaId)!).ests.push(e);
    }
    this.vizinhas.clear();
    if (deposito) for (const { ests } of grupos.values()) { const ids = ests.map((e) => e.itemId); for (const id of ids) this.vizinhas.set(id, ids); }
    const corredor = 1.6, margem = 0.7, titulo = 0.6, folga = 0.5, entreFilas = 1.1;
    const medidas = new Map<string, THREE.Box3>();
    let area = 0;
    for (const e of this.estacoes.values()) {
      e.grupo.position.set(0, 0, 0);
      if (deposito) this.porSuporte(e);
      const bb = caixa(e.grupo);
      medidas.set(e.itemId, bb);
      const t = bb.getSize(new THREE.Vector3());
      area += (Math.max(t.x, 1.4) + folga) * (Math.max(t.z, 1) + entreFilas);
    }
    // Curva ABC pelo custo: a cor da placa mostra o peso de cada entrada no orçamento.
    const custos = itens.map((i) => ({ id: i.itemId, c: i.pecas.reduce((t, p) => t + (p.custo ?? 0), 0) })).sort((a, b) => b.c - a.c);
    const total = custos.reduce((t, c) => t + c.c, 0);
    const classe = new Map<string, "a" | "b" | "c">();
    let acumulado = 0;
    for (const c of custos) { classe.set(c.id, total <= 0 || c.c <= 0 ? "c" : acumulado < total * 0.8 ? "a" : acumulado < total * 0.95 ? "b" : "c"); acumulado += c.c; }

    // Depósito: áreas de largura fixa, em colunas, para o pátio ficar próximo de um quadrado.
    const larguraArea = 10.4;
    const limite = deposito ? larguraArea : Math.max(9, Math.sqrt(area) * 1.7);
    const alturaAlvo = deposito ? Math.max(12, Math.sqrt(area * 1.9)) : Infinity;
    let z = 0, x0 = 0, largura = deposito ? larguraArea : 0, fundo = 0, coluna = 0;
    const blocos: { x0: number; z0: number; z1: number; nome: string; id: string; primeira: string; custo: number; coluna: number }[] = [];
    const larguraColuna: number[] = [];
    for (const [idGrupo, { nome, ests }] of grupos) {
      if (deposito && z > 0 && z >= alturaAlvo) { x0 += (larguraColuna[coluna] ?? larguraArea) + corredor; z = 0; coluna += 1; }
      const z0 = z;
      const tams = ests.map((e) => medidas.get(e.itemId)!.getSize(new THREE.Vector3()));
      const ordenadas = tams.map((t) => t.x).sort((a, b) => a - b);
      const U = Math.max(2, Math.min(3.2, ordenadas[Math.floor(ordenadas.length / 2)] + folga));
      const colunas = Math.max(3, Math.floor((limite - margem * 2) / U));
      let col = 0, zf = z + margem + titulo, prof = 0, maxX = 0;
      let fila: { e: Estacao; cx: number; frente: number }[] = [];
      const fechar = () => {
        for (const { e, cx, frente } of fila) this.placa(e, porId.get(e.itemId)!, cx, zf + frente + 0.12, deposito, classe.get(e.itemId) ?? "c");
        fila = [];
      };
      ests.forEach((e, k) => {
        const bb = medidas.get(e.itemId)!, t = tams[k];
        const n = Math.max(1, Math.ceil((t.x + folga * 0.5) / U));
        if (col > 0 && col + n > colunas) { fechar(); zf += prof + entreFilas; col = 0; prof = 0; }
        const cx = x0 + margem + (col + n / 2) * U;
        e.grupo.position.set(cx - (bb.min.x + bb.max.x) / 2, 0, zf - bb.min.z);
        col += n;
        maxX = Math.max(maxX, col * U);
        prof = Math.max(prof, t.z);
        fila.push({ e, cx, frente: t.z });
      });
      fechar();
      const z1 = zf + prof + 0.75 + margem * 0.4;
      const custoBloco = ests.reduce((t, e) => t + (porId.get(e.itemId)?.pecas.reduce((s, p) => s + (p.custo ?? 0), 0) ?? 0), 0);
      blocos.push({ x0, z0, z1, nome, id: idGrupo, primeira: ests[0]?.itemId ?? "", custo: custoBloco, coluna });
      largura = Math.max(largura, maxX + margem * 2);
      larguraColuna[coluna] = Math.max(larguraColuna[coluna] ?? (deposito ? larguraArea : 0), maxX + margem * 2);
      fundo = Math.max(fundo, z1);
      z = z1 + corredor;
    }
    const fim = fundo;
    const larguraTotal = deposito ? x0 + (larguraColuna[coluna] ?? larguraArea) : x0 + largura;
    if (deposito && blocos.length) {
      const p = { x0: -0.6, x1: larguraTotal + 0.6, z0: -0.6, z1: fim + 0.6 };
      this.patio = p;
    }
    for (const b of blocos) {
      const w = deposito ? larguraColuna[b.coluna] : largura, d = b.z1 - b.z0;
      // Laje da área: tem espessura e meio-fio, para não parecer um plano solto.
      const topo = new THREE.MeshStandardMaterial({ map: this.texturaEscalada(this.texConcreto, w / 3, d / 3), roughness: 0.95 });
      const lado = new THREE.MeshStandardMaterial({ color: 0xb9b7b1, roughness: 1 });
      const piso = new THREE.Mesh(new THREE.BoxGeometry(w, 0.14, d), [lado, lado, topo, lado, lado, lado]);
      piso.position.set(b.x0 + w / 2, -0.07, b.z0 + d / 2);
      piso.receiveShadow = true; piso.castShadow = true;
      const borda = new THREE.Group();
      const mf = 0.09;
      for (const [bw, bd, bx, bz] of [[w + mf * 2, mf, 0, -d / 2 - mf / 2], [w + mf * 2, mf, 0, d / 2 + mf / 2], [mf, d, -w / 2 - mf / 2, 0], [mf, d, w / 2 + mf / 2, 0]]) {
        const m = new THREE.Mesh(new THREE.BoxGeometry(bw, 0.2, bd), MAT_CONCRETO);
        m.position.set(bx, -0.04, bz);
        m.castShadow = true; m.receiveShadow = true;
        borda.add(m);
      }
      borda.position.set(b.x0 + w / 2, 0, b.z0 + d / 2);
      let el: HTMLElement;
      if (deposito) {
        // Etiqueta do item do orçamento: número, descrição e custo; o clique seleciona o item.
        el = document.createElement("button");
        (el as HTMLButtonElement).type = "button";
        el.className = "v3d-area-titulo v3d-area-item";
        el.dataset.bloco = b.id;
        el.title = b.nome;
        const nome = document.createElement("b");
        const corte = b.nome.indexOf(" ");
        const texto = b.nome.slice(corte + 1).toLowerCase();
        nome.textContent = b.nome.slice(0, corte);
        const desc = document.createElement("em");
        desc.textContent = `${texto.charAt(0).toUpperCase()}${texto.slice(1)}`;
        el.append(nome, desc);
        if (b.custo > 0) { const v = document.createElement("span"); v.textContent = reais(b.custo); el.append(v); }
        const primeira = b.primeira;
        el.addEventListener("click", () => this.opcoes.onSelecionar?.(primeira));
      } else {
        el = document.createElement("div");
        el.className = "v3d-area-titulo";
        el.textContent = b.nome;
      }
      const t = new CSS2DObject(el);
      t.position.set(b.x0 + 0.15, 0.01, b.z0 + 0.15);
      t.center.set(0, 0);
      this.areas.add(piso, borda, t);
    }
    if (!this.areas.parent) this.raiz.add(this.areas);
    this.centralizarRaiz();
  }

  /** Põe a peça da entrada do depósito no suporte certo (palete, cavalete, estante, baia ou vaga). */
  private porSuporte(e: Estacao) {
    const l = e.pecas[0];
    if (!l) return;
    l.grupo.position.y = 0;
    const bb = caixa(l.grupo);
    if (bb.isEmpty()) return;
    const t = bb.getSize(new THREE.Vector3());
    const { grupo, elevacao } = criarSuporte(tipoSuporte(l.peca, t), t);
    grupo.position.set((bb.min.x + bb.max.x) / 2, 0, (bb.min.z + bb.max.z) / 2);
    e.grupo.add(grupo);
    e.grupo.userData.suporte = grupo;
    l.grupo.position.y = elevacao;
  }

  private tirarSuporte(e: Estacao) {
    const sup = e.grupo.userData.suporte as THREE.Group | undefined;
    if (sup) { e.grupo.remove(sup); e.grupo.userData.suporte = undefined; }
    for (const l of e.pecas) l.grupo.position.y = 0;
    if (e.rotulo) { e.rotulo.removeFromParent(); e.rotulo.element.remove(); e.rotulo = undefined; }
  }

  /** Placa da vaga: no depósito, nome, quantidade e valor; no serviço montado, o número do item. */
  private placa(e: Estacao, item: CenaItem, x: number, z: number, deposito: boolean, classe: "a" | "b" | "c") {
    const el = document.createElement("button");
    el.type = "button";
    el.title = item.descricao;
    if (deposito) {
      const p = item.pecas[0];
      const custo = item.pecas.reduce((t, c) => t + (c.custo ?? 0), 0);
      el.className = `v3d-marcador v3d-placa v3d-placa-${classe}`;
      el.dataset.bloco = item.etapaId;
      const nome = document.createElement("b");
      const curto = p?.papel === "mao_de_obra" ? p.nome.split(":")[0] : item.descricao.toLowerCase();
      nome.textContent = curto.charAt(0).toUpperCase() + curto.slice(1);
      const qtd = document.createElement("span");
      qtd.textContent = item.numero;
      const valor = document.createElement("i");
      valor.textContent = custo > 0 ? reais(custo) : "";
      el.append(qtd, nome, valor);
    } else {
      el.className = "v3d-marcador";
      el.textContent = item.numero;
    }
    el.addEventListener("click", () => this.opcoes.onSelecionar?.(item.itemId));
    const obj = new CSS2DObject(el);
    obj.position.set(x, 0.02, z);
    obj.center.set(0.5, 0);
    this.areas.add(obj);
    e.rotulo = obj;
  }

  private texturaEscalada(t: THREE.Texture, u: number, v: number) {
    const c = t.clone();
    c.repeat.set(u, v);
    c.needsUpdate = true;
    return c;
  }

  private limparAreas() {
    for (const o of [...this.areas.children]) {
      this.areas.remove(o);
      const m = o as THREE.Mesh;
      if (m.geometry !== CUBO) m.geometry?.dispose();
      for (const mm of ([] as (THREE.Material | undefined)[]).concat(m.material)) {
        const mapa = (mm as THREE.MeshStandardMaterial | undefined)?.map;
        if (mapa && mapa !== this.texConcreto) mapa.dispose();
        mm?.dispose?.();
      }
      if (o instanceof CSS2DObject) o.element.remove();
    }
  }

  private centralizarRaiz() {
    const bb = caixa(this.raiz);
    if (!bb.isEmpty()) {
      const c = bb.getCenter(new THREE.Vector3());
      this.raiz.position.x -= c.x; this.raiz.position.z -= c.z;
    }
  }


  private ajustarChao() {
    const bb = caixa(this.raiz);
    const tam = bb.isEmpty() ? new THREE.Vector3(4, 1, 4) : bb.getSize(new THREE.Vector3());
    const s = this.sol.shadow.camera;
    const m = Math.max(tam.x, tam.z, tam.y) * 0.75 + 2;
    s.left = -m; s.right = m; s.top = m; s.bottom = -m; s.near = 0.1; s.far = m * 7;
    this.alcanceSol = m;
    this.posicionarSol();
    s.updateProjectionMatrix();
  }

  // -------------------------------------------------------------------------
  // Câmera
  // -------------------------------------------------------------------------
  private enquadrar(o: THREE.Object3D | THREE.Box3, imediato: boolean) {
    // Um serviço sozinho: de frente e um pouco de cima, ocupando a tela.
    const sozinho = this.ultimoModo === "item" && this.vistaAtual === "perspectiva" && !(o instanceof THREE.Box3);
    const bb = o instanceof THREE.Box3 ? o : sozinho ? caixaVisivel(o) : caixa(o);
    if (bb.isEmpty()) return;
    const centro = bb.getCenter(new THREE.Vector3());
    const tam = bb.getSize(new THREE.Vector3());
    // Distância para caber na tela: largura e profundidade pesam mais que a altura.
    const raio = Math.max(0.35, Math.hypot(tam.x, tam.z, tam.y * 0.6) / 2);
    const vfov = THREE.MathUtils.degToRad(this.camera.fov / 2);
    const hfov = Math.atan(Math.tan(vfov) * this.camera.aspect);
    const geral = o === this.raiz && this.estacoes.size > 1;
    // Sozinho, a fileira inteira precisa caber na largura da tela, com folga para as etiquetas.
    const dist = sozinho ? Math.max((tam.x / 2) / Math.tan(hfov), (tam.y / 2) / Math.tan(vfov), 2.2) * 1.15 + tam.z / 2 : (raio / Math.sin(Math.min(vfov, hfov))) * (this.vistaAtual === "planta" || this.vistaAtual === "superior" ? 0.95 : geral ? 0.76 : o instanceof THREE.Box3 ? 1.3 : 1.05);
    // Visão geral do canteiro mais de cima, como a planta de um depósito.
    const dir = (this.vistaAtual !== "perspectiva" ? new THREE.Vector3(...DIRECAO[this.vistaAtual]) : geral ? new THREE.Vector3(0.25, 0.95, 1) : sozinho ? new THREE.Vector3(0.18, 0.42, 1) : new THREE.Vector3(0.55, 0.5, 1)).normalize();
    const destinoCam = centro.clone().add(dir.multiplyScalar(dist));
    centro.y = Math.max(centro.y * 0.8, 0.1);
    if (imediato || reduzirMovimento()) {
      this.camera.position.copy(destinoCam);
      this.controles.target.copy(centro);
      return;
    }
    const c0 = this.camera.position.clone(), t0 = this.controles.target.clone();
    this.tarefa(800, (t) => {
      const k = suave(t);
      this.camera.position.lerpVectors(c0, destinoCam, k);
      this.controles.target.lerpVectors(t0, centro, k);
    });
  }

  focar(itemId: string, imediato = false) {
    const e = this.estacoes.get(itemId);
    const area = this.vizinhas.get(itemId);
    if (e && area && area.length > 1) {
      // Depósito por item: enquadra a área inteira do item, não só a primeira peça.
      const bb = new THREE.Box3();
      for (const id of area) { const v = this.estacoes.get(id); if (v) bb.union(caixa(v.grupo)); }
      this.enquadrar(bb, imediato);
    } else if (e) this.enquadrar(e.grupo, imediato);
    // Na obra, o elemento do item escolhido fica contornado.
    this.selecao.visible = !!e && this.ultimoModo === "obra";
    if (e && this.selecao.visible) this.selecao.box.copy(caixa(e.grupo)).expandByScalar(0.02);
    for (const [id, est] of this.estacoes) est.rotulo?.element.classList.toggle("v3d-marcador-ativo", id === itemId);
  }

  centralizar() { this.enquadrar(this.raiz, false); }

  // -------------------------------------------------------------------------
  // Controles da cena: vistas, zoom, filtros, custo, medição
  // -------------------------------------------------------------------------
  /** Perspectiva, superior, frontal, lateral ou planta (de cima, quase sem perspectiva). */
  vista(v: Vista) {
    this.vistaAtual = v;
    const planta = v === "planta";
    this.camera.fov = planta ? FOV_PLANTA : FOV;
    this.camera.near = planta ? 15 : 0.15;
    if (this.oclusao) this.oclusao.enabled = !planta && this.nivel === 0;
    this.camera.updateProjectionMatrix();
    const nevoa = this.cena.fog as THREE.Fog;
    nevoa.near = planta ? 4000 : 90; nevoa.far = planta ? 9000 : 650;
    this.controles.maxDistance = planta ? 1500 : 400;
    this.enquadrar(this.raiz, planta || reduzirMovimento());
  }

  zoom(fator: number) {
    const alvo = this.controles.target, c0 = this.camera.position.clone();
    const d = THREE.MathUtils.clamp(c0.distanceTo(alvo) * fator, this.controles.minDistance, this.controles.maxDistance);
    const c1 = alvo.clone().add(c0.clone().sub(alvo).setLength(d));
    this.tarefa(220, (t) => this.camera.position.lerpVectors(c0, c1, suave(t)));
  }

  etiquetas(visiveis: boolean) { this.rotulos.domElement.style.visibility = visiveis ? "" : "hidden"; }

  /** Imagem da cena como está na tela. */
  imagem(): string {
    if (this.compositor) this.compositor.render(); else this.renderer.render(this.cena, this.camera);
    return this.renderer.domElement.toDataURL("image/png");
  }

  /** Largura, altura e profundidade que o elemento ocupa na cena, em metros. */
  dimensoes(itemId: string): [number, number, number] | null {
    const e = this.estacoes.get(itemId);
    if (!e) return null;
    const t = new THREE.Box3();
    for (const p of e.pecas) t.union(caixa(p.grupo));
    if (t.isEmpty()) return null;
    const s = t.getSize(new THREE.Vector3());
    return [s.x, s.y, s.z];
  }

  /** Destaca só o que passa no filtro; o resto fica translúcido. */
  destacar(f: Filtro) { this.filtro = f; this.aplicarFiltro(); }
  private aplicarFiltro() {
    for (const [id, e] of this.estacoes) {
      let algum = false;
      for (const p of e.pecas) {
        const fantasma = !!this.filtro && !this.filtro(id, p.peca.papel);
        if (!fantasma) algum = true;
        p.grupo.traverse((o) => {
          if (o instanceof CSS2DObject) { o.element.style.display = fantasma ? "none" : ""; return; }
          const m = o as THREE.Mesh;
          if (!m.isMesh) { if ((o as THREE.Points).isPoints) o.visible = !fantasma; return; }
          if (fantasma && !m.userData.fantasma) { m.userData.original = m.material; m.userData.sombra = m.castShadow; m.userData.fantasma = true; m.material = MAT_FANTASMA; m.castShadow = false; }
          else if (!fantasma && m.userData.fantasma) { m.material = m.userData.original as THREE.Material; m.castShadow = !!m.userData.sombra; m.userData.fantasma = false; }
        });
      }
      if (e.rotulo) e.rotulo.element.style.display = this.filtro && !algum ? "none" : "";
    }
  }

  /** Visualizar por custo: disco e coluna em cada elemento, proporcionais ao peso dele no orçamento. */
  verCusto(ligado: boolean) { this.porCusto = ligado; this.desenharCusto(); }
  private desenharCusto() {
    for (const o of [...this.custos.children]) { const m = o as THREE.Mesh; m.geometry.dispose(); (m.material as THREE.Material).dispose(); }
    this.custos.clear();
    if (!this.porCusto) return;
    const valores = [...this.estacoes.values()].map((e) => ({ e, v: e.pecas.reduce((t, p) => t + (p.peca.custo ?? 0), 0) })).filter((x) => x.v > 0);
    const maior = Math.max(0, ...valores.map((x) => x.v));
    if (!maior) return;
    const frio = new THREE.Color(0x2a7f8c), quente = new THREE.Color(0xf28c28);
    for (const { e, v } of valores) {
      const bb = new THREE.Box3();
      for (const p of e.pecas) bb.union(caixa(p.grupo));
      if (bb.isEmpty()) continue;
      const k = v / maior, c = bb.getCenter(new THREE.Vector3()), t = bb.getSize(new THREE.Vector3());
      const cor = frio.clone().lerp(quente, Math.sqrt(k));
      const raio = Math.max(t.x, t.z) / 2 + 0.25 + k * 0.45;
      const disco = new THREE.Mesh(new THREE.CircleGeometry(raio, 48), new THREE.MeshBasicMaterial({ color: cor, transparent: true, opacity: 0.25 + 0.45 * k, depthWrite: false }));
      disco.rotation.x = -Math.PI / 2; disco.position.set(c.x, 0.04, c.z);
      const alt = 0.25 + k * 2.6;
      const coluna = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, alt, 16), new THREE.MeshBasicMaterial({ color: cor, transparent: true, opacity: 0.9 }));
      coluna.position.set(c.x - raio * 0.72, alt / 2, c.z - raio * 0.72);
      this.custos.add(disco, coluna);
    }
  }

  /** Medição: cada clique marca um ponto. Dois pontos dão a distância; três ou mais, perímetro e área. */
  medir(ligado: boolean) {
    this.medindo = ligado;
    this.renderer.domElement.style.cursor = ligado ? "crosshair" : "";
    this.aoSair();
    if (!ligado) this.limparMedida();
  }
  limparMedida() { this.pontos = []; this.desenharMedida(); }
  private desenharMedida() {
    for (const o of [...this.medida.children]) { const m = o as THREE.Mesh; if (m.geometry) m.geometry.dispose(); }
    this.medida.clear();
    const pts = this.pontos;
    if (!pts.length) { this.opcoes.onMedir?.(null); return; }
    const d = this.camera.position.distanceTo(pts[0]);
    for (const p of pts) {
      const b = new THREE.Mesh(new THREE.SphereGeometry(Math.max(0.03, d * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * 0.016), 16, 12), MAT_MEDIDA);
      b.position.copy(p); b.renderOrder = 11;
      this.medida.add(b);
    }
    const fechado = pts.length >= 3;
    const trechos: [THREE.Vector3, THREE.Vector3][] = [];
    for (let i = 1; i < pts.length; i++) trechos.push([pts[i - 1], pts[i]]);
    if (fechado) trechos.push([pts[pts.length - 1], pts[0]]);
    let comprimento = 0;
    for (const [a, b] of trechos) {
      const linha = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), new THREE.LineBasicMaterial({ color: 0xf28c28, depthTest: false }));
      linha.renderOrder = 11;
      const el = document.createElement("div");
      el.className = "v3d-medida";
      el.textContent = metros(a.distanceTo(b));
      const r = new CSS2DObject(el);
      r.position.copy(a).add(b).multiplyScalar(0.5);
      this.medida.add(linha, r);
      comprimento += a.distanceTo(b);
    }
    let area: number | null = null;
    if (fechado) {
      let s = 0;
      for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; s += a.x * b.z - b.x * a.z; }
      area = Math.abs(s) / 2;
    }
    const ys = pts.map((p) => p.y);
    this.opcoes.onMedir?.({ pontos: pts.length, comprimento, area, desnivel: Math.max(...ys) - Math.min(...ys) });
  }

  // -------------------------------------------------------------------------
  // Animações de entrada
  // -------------------------------------------------------------------------
  tocar(itemId?: string) {
    const lista = itemId ? [this.estacoes.get(itemId)].filter((e): e is Estacao => !!e) : [...this.estacoes.values()];
    lista.forEach((e) => this.tocarEstacao(e));
  }

  private tocarEstacao(e: Estacao) {
    for (const { peca, grupo } of e.pecas) {
      if (peca.video) this.tocarVideo(peca, grupo);
      else if (peca.visual.tipo === "kit") this.tocarMontagem(grupo);
      else if (peca.visual.tipo === "pilha") this.tocarQueda(grupo, 0);
      else if (peca.animado && peca.papel !== "mao_de_obra") void this.tocarGravada(peca, grupo);
      else if (peca.visual.tipo === "monte") this.surgirMonte(peca, grupo);
      else this.surgir(grupo);
    }
  }

  /** Kit montado etapa por etapa (tipo G). */
  private tocarMontagem(grupo: THREE.Group) {
    const kits = corpo(grupo).children;
    const total = Math.max(1, Math.max(...kits.map(etapasDoKit)));
    const porEtapa = 650;
    this.tarefa(porEtapa * total, (t) => {
      const pos = t * total;
      const etapa = Math.min(total, Math.floor(pos) + 1);
      kits.forEach((k) => aplicarEtapa(k, t >= 1 ? Infinity : etapa, pos - (etapa - 1)));
    }, () => kits.forEach((k) => aplicarEtapa(k, Infinity)));
  }

  /** Peças da pilha caem uma a uma a partir da posição `desde`. */
  private tocarQueda(grupo: THREE.Group, desde: number) {
    const cair = grupo.userData.cair as Queda | undefined;
    if (!cair) return;
    const animar = this.opcoes.animacoes && !reduzirMovimento();
    const q = cair(desde, animar ? (p, v) => this.poeira(p, v) : undefined);
    if (!q) return;
    if (!animar) { q.quadro(1); return; }
    this.tarefa(q.segundos * 1000, q.quadro, () => q.quadro(1));
  }

  /** Poeira levantada no impacto: sobe, espalha e some. */
  private poeira(p: THREE.Vector3, velocidade: number, cor = 0xcdbb9c) {
    const n = Math.round(8 + Math.min(14, velocidade * 2));
    const pos = new Float32Array(n * 3), vel = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const ang = Math.random() * Math.PI * 2, r = 0.05 + Math.random() * 0.2, f = 0.4 + Math.random() * 0.9;
      pos.set([p.x + Math.cos(ang) * r, p.y + 0.03, p.z + Math.sin(ang) * r], i * 3);
      vel.set([Math.cos(ang) * f, 0.25 + Math.random() * 0.6, Math.sin(ang) * f], i * 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({ map: this.grao, color: cor, size: 0.3, transparent: true, opacity: 0.45, depthWrite: false });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    this.cena.add(pts);
    let antes = 0;
    this.tarefa(950, (t) => {
      const dt = (t - antes) * 0.95; antes = t;
      for (let i = 0; i < n * 3; i += 3) {
        pos[i] += vel[i] * dt; pos[i + 1] += vel[i + 1] * dt; pos[i + 2] += vel[i + 2] * dt;
        const freio = 1 - Math.min(1, 3 * dt);
        vel[i] *= freio; vel[i + 1] = vel[i + 1] * freio - 0.3 * dt; vel[i + 2] *= freio;
      }
      geo.attributes.position.needsUpdate = true;
      mat.opacity = 0.45 * (1 - t);
      mat.size = 0.3 + 0.6 * t;
    }, () => { this.cena.remove(pts); geo.dispose(); mat.dispose(); });
  }

  /** Grãos escorrendo sobre o monte (areia, brita, terra) enquanto ele cresce. */
  private despejar(g: THREE.Object3D, topo: number, raio: number, ms: number, cor: number) {
    const n = 220, hq = 1.3, tq = Math.sqrt((2 * hq) / G), dur = ms / 1000;
    const pos = new Float32Array(n * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({ map: this.grao, color: cor, size: Math.max(0.035, raio * 0.07), transparent: true, alphaTest: 0.3 });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    g.add(pts);
    this.tarefa(ms, (t) => {
      const tau = t * dur;
      for (let i = 0; i < n; i++) {
        const idade = ((tau / tq + acaso(i, 7)) % 1) * tq;
        const ativo = tau - idade >= 0 && tau - idade < dur - tq;
        const ang = acaso(i, 8) * Math.PI * 2, abre = (0.03 + acaso(i, 9) * 0.1) * raio;
        const esp = abre * (1 + (idade / tq) * 2.2);
        pos.set(ativo ? [Math.cos(ang) * esp, topo + hq - (G * idade * idade) / 2, Math.sin(ang) * esp] : [0, -50, 0], i * 3);
      }
      geo.attributes.position.needsUpdate = true;
    }, () => { g.remove(pts); geo.dispose(); mat.dispose(); });
  }

  /** Monte sem animação gravada: cresce enquanto os grãos escorrem. */
  private surgirMonte(peca: Peca, grupo: THREE.Group) {
    const c = corpo(grupo);
    c.scale.setScalar(1);
    const t = new THREE.Box3().setFromObject(c).getSize(new THREE.Vector3());
    this.despejar(grupo, t.y, Math.max(t.x, t.z) / 2, 1700, corDoGranel(peca.origem));
    this.tarefa(1700, (f) => { const k = Math.max(1e-3, Math.cbrt(suave(f))); c.scale.set(Math.min(1, k * 1.12), k * k, Math.min(1, k * 1.12)); }, () => c.scale.setScalar(1));
  }


  private surgir(grupo: THREE.Group) {
    const c = corpo(grupo);
    this.tarefa(700, (t) => c.scale.setScalar(Math.max(1e-3, suave(t))), () => c.scale.setScalar(1));
  }

  /** Equipe trabalhando: o gesto do ofício gravado no Blender fica em repetição; o anel de horas continua o da figura parada. */
  private async gesto(peca: Peca, g: THREE.Group, parada: THREE.Object3D) {
    let gltf: GLTF;
    try { gltf = await carregar(urlAnimacao(peca.codigo)); } catch { return; }
    if (!gltf.animations.length) return;
    const cena = clonarComEsqueleto(gltf.scene);
    cena.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) o.frustumCulled = false; });
    prepararSombras(cena);
    // Corpo da figura animada (sem ferramenta nem anel), anotado antes de trocar os materiais.
    const corpoAnimado: THREE.Object3D[] = [];
    cena.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && !Array.isArray(m.material) && m.material.name.startsWith("Manequim")) corpoAnimado.push(o); });
    vestirGesto(cena);
    const corpoParado: THREE.Object3D[] = [];
    parada.traverse((o) => { if ((o as THREE.Mesh).isMesh && o.visible && !/_anel_|_fer[DE]_/.test(o.name)) corpoParado.push(o); });
    const base = (os: THREE.Object3D[]) => {
      const bb = new THREE.Box3();
      for (const o of os) bb.union(caixa(o));
      return bb.isEmpty() ? null : new THREE.Vector3((bb.min.x + bb.max.x) / 2, bb.min.y, (bb.min.z + bb.max.z) / 2);
    };
    const pesParado = base(corpoParado);
    parada.traverse((o) => { if ((o as THREE.Mesh).isMesh && !/_anel_/.test(o.name)) o.visible = false; });
    g.add(cena);
    const mixer = new THREE.AnimationMixer(cena);
    for (const clip of gltf.animations) fecharMaos(clip);
    for (const clip of gltf.animations) { const a = mixer.clipAction(clip); a.setLoop(THREE.LoopPingPong, Infinity); a.play(); }
    mixer.timeScale = 0.8;
    // A figura animada fica exatamente sobre a parada (e sobre o anel de horas), e não deslocada para cima de outra peça.
    mixer.update(0);
    const pesAnimado = base(corpoAnimado);
    if (pesParado && pesAnimado) {
      g.updateMatrixWorld(true);
      const delta = g.worldToLocal(pesParado.clone()).sub(g.worldToLocal(pesAnimado.clone()));
      if (delta.length() < 20) cena.position.add(delta);
    }
    this.gestos.push({ mixer, cena });
  }

  /** Animação gravada no Blender (_anim.glb): toca uma vez e devolve a peça montada. */
  private async tocarGravada(peca: Peca, grupo: THREE.Group) {
    let gltf: GLTF;
    try { gltf = await carregar(urlAnimacao(peca.codigo)); } catch { this.surgir(grupo); return; }
    if (!gltf.animations.length) { this.surgir(grupo); return; }
    const cena = gltf.scene.clone(true);
    prepararSombras(cena);
    const ancora = new THREE.Group();
    const bb = caixa(grupo);
    const pai = grupo.parent!;
    ancora.position.set((bb.min.x + bb.max.x) / 2 - pai.getWorldPosition(new THREE.Vector3()).x, grupo.position.y, (bb.min.z + bb.max.z) / 2 - pai.getWorldPosition(new THREE.Vector3()).z);
    if (peca.visual.tipo === "monte") cena.scale.setScalar(peca.visual.escala);
    ancora.add(cena);
    pai.add(ancora);
    const c = corpo(grupo);
    c.visible = false;
    const mixer = new THREE.AnimationMixer(cena);
    let dur = 0;
    for (const clip of gltf.animations) {
      const a = mixer.clipAction(clip);
      a.setLoop(THREE.LoopOnce, 1);
      a.clampWhenFinished = true;
      a.play();
      dur = Math.max(dur, clip.duration);
    }
    this.mixers.add(mixer);
    window.setTimeout(() => {
      this.mixers.delete(mixer);
      mixer.stopAllAction();
      pai.remove(ancora);
      c.visible = true;
    }, Math.min(6000, dur * 1000 + 150));
  }

  /** Líquidos (concreto, tinta, emulsão): vídeo com fundo transparente gravado no Blender. */
  private tocarVideo(peca: Peca, grupo: THREE.Group) {
    const video = document.createElement("video");
    video.src = urlVideo(peca.codigo);
    video.muted = true; video.playsInline = true; video.crossOrigin = "anonymous";
    const tex = new THREE.VideoTexture(video);
    tex.colorSpace = THREE.SRGBColorSpace;
    const bb = caixa(grupo);
    const alt = Math.max(1, (bb.max.y - bb.min.y) * 2.2);
    const plano = new THREE.Mesh(new THREE.PlaneGeometry(alt * 16 / 9, alt), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false }));
    const pai = grupo.parent!;
    plano.position.set((bb.min.x + bb.max.x) / 2 - pai.getWorldPosition(new THREE.Vector3()).x, alt / 2, (bb.min.z + bb.max.z) / 2 - pai.getWorldPosition(new THREE.Vector3()).z);
    const c = corpo(grupo);
    c.visible = false;
    pai.add(plano);
    const olhar = () => plano.quaternion.copy(this.camera.quaternion);
    const t = this.tarefa(8000, olhar);
    const fim = () => {
      this.tarefas.delete(t);
      pai.remove(plano); plano.geometry.dispose(); (plano.material as THREE.Material).dispose(); tex.dispose();
      video.removeAttribute("src"); video.load();
      c.visible = true;
      this.surgir(grupo);
    };
    video.addEventListener("ended", fim, { once: true });
    video.addEventListener("error", fim, { once: true });
    video.play().catch(fim);
  }

  // -------------------------------------------------------------------------
  // Limpeza
  // -------------------------------------------------------------------------
  private descartar(e: Estacao) {
    e.grupo.traverse((o) => { if (o instanceof CSS2DObject) o.element.remove(); });
    e.grupo.removeFromParent();
    // Geometrias e materiais são compartilhados com o cache dos modelos: só as instâncias são liberadas.
    e.grupo.traverse((o) => { if ((o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).dispose(); });
    if (e.pecas[0]?.chave === "obra") e.grupo.traverse((o) => { const m = o as THREE.Mesh; if (!m.isMesh) return; m.geometry.dispose(); const mm = (m.userData.fantasma ? m.userData.original : m.material) as THREE.MeshStandardMaterial; mm.map?.dispose(); mm.dispose(); });
  }

  private limpar() {
    this.limparProjeto();
    for (const e of this.estacoes.values()) this.descartar(e);
    this.estacoes.clear();
    this.visuais.clear();
  }

  destruir() {
    cancelAnimationFrame(this.quadro);
    this.observador.disconnect();
    this.renderer.domElement.removeEventListener("pointerdown", this.aoApertar);
    this.renderer.domElement.removeEventListener("pointerup", this.aoSoltar);
    this.container.removeEventListener("pointerenter", this.aoEntrar);
    this.container.removeEventListener("pointerleave", this.aoDeixar);
    window.removeEventListener("keydown", this.aoTeclar);
    window.removeEventListener("keyup", this.aoSoltarTecla);
    window.removeEventListener("blur", this.aoDeixar);
    this.limpar();
    this.controles.dispose();
    this.compositor?.dispose();
    this.pmrem.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.rotulos.domElement.remove();
  }
}

export function reduzirMovimento() {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

export function suporteWebGL() {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch { return false; }
}
