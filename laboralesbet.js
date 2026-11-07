// LaboralesBet: apuestas de broma con fichas (sin dinero), con cuotas fijas y combinadas.
// Cada jugador empieza con SALDO_INICIAL fichas; lo que gana o pierde se acumula partido a partido.
// Los datos se guardan en Firebase (Firestore). La configuración va en firebase-config.js.
//   apuestas/<id>  = un mercado: { tipo: "cuotas", titulo, opciones[], cuotas[], estado, ganadora, cierre, partido… }
//   votos/<uid>    = un apostador: { apodo, boletos: [{ id, t, fichas, sel: [{ a, op, c }] }], picks (sistema antiguo) }
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, collection, doc, onSnapshot, setDoc, updateDoc, deleteDoc, addDoc, getDoc, writeBatch } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const SALDO_INICIAL = 1000;
const MAX_SELECCIONES = 10;

// ---------- Amistoso contra RESA (6-11-2026): se jugó con el sistema antiguo de bote compartido ----------
// Sus resultados van aquí; lo que cada uno ganó o perdió ese día se suma a su saldo inicial.
const LEGADO_PID = "2026-11-06-resa";
const LEGADO_TITULARES = ["ruben", "alejandro", "emi", "d-escalona", "a-escalona", "manuel-g", "francisco", "alonso", "lorenzo", "dennis", "crispin"];
const LEGADO_GANADORAS = {
  resultado: "Laborales FC", goles: "3", "primer-gol": "Crispín", asistencia: "Lorenzo", encajados: "Ninguno",
  "portero-titular": "Rubén", "primer-cambio": "Samu", agresion: "Ninguno, partido de guante blanco",
  "fuera-juego": "3", velocidad: "D. Escalona", regates: "Francisco Caro", perdidas: "Alejandro Gil",
};

// Mercados especiales de un partido concreto (clave = fecha del partido). Se añaden al pulsar
// "Crear mercados del partido". Cuota opcional: sin ella, todas las opciones pagan lo mismo. Ejemplo:
// "2026-11-12": [{ clave: "tarjeta", titulo: "¿Ve Emi una tarjeta?", opciones: [["Sí", 2.5], ["No", 1.5]] }],
// También admite "bloque" (para agruparlos) y "orden" (posición en la lista).
// Partido de 2 × 40 min, árbitros que sacan pocas tarjetas, y el Laborales con laterales y extremos rápidos (más córners).
const EXTRAS = {
  "2026-11-12": [
    { clave: "margen", orden: 1.5, titulo: "Margen de victoria", descripcion: "Diferencia de goles al final del partido.",
      opciones: [["Laborales por 1", 5.00], ["Laborales por 2", 6.00], ["Laborales por 3 o más", 5.50], ["Empate", 3.20],
        ["Derecho por 1", 5.50], ["Derecho por 2", 9.00], ["Derecho por 3 o más", 13]] },

    { clave: "corners-total", bloque: "Córners", titulo: "Córners totales", descripcion: "Los de los dos equipos en los 80 minutos.",
      opciones: [["Menos de 8,5", 1.85], ["Más de 8,5", 1.85]] },
    { clave: "corners-laborales", bloque: "Córners", titulo: "Córners del Laborales", opciones: [["Menos de 4,5", 2.10], ["Más de 4,5", 1.65]] },
    { clave: "corners-mas", bloque: "Córners", titulo: "¿Quién saca más córners?", opciones: [["Laborales FC", 1.55], ["Empate", 6.00], ["Derecho", 2.60]] },
    { clave: "corners-primero", bloque: "Córners", titulo: "Primer córner del partido", opciones: [["Laborales FC", 1.60], ["Derecho", 2.20], ["Ninguno", 21]] },

    { clave: "fueras-total", bloque: "Fueras de juego", titulo: "Fueras de juego totales", opciones: [["Menos de 3,5", 1.80], ["Más de 3,5", 1.90]] },
    { clave: "fueras-mas", bloque: "Fueras de juego", titulo: "¿Quién cae más en fuera de juego?", opciones: [["Laborales FC", 1.70], ["Empate", 3.80], ["Derecho", 2.60]] },
    { clave: "fueras-crispin", bloque: "Fueras de juego", titulo: "Fueras de juego de Crispín", descripcion: "En el amistoso le pitaron 3.",
      opciones: [["0", 3.40], ["1", 3.00], ["2", 3.60], ["3 o más", 3.80]] },

    { clave: "tarjetas-total", bloque: "Tarjetas", titulo: "Tarjetas en el partido", descripcion: "Amarillas y rojas de los dos equipos. Una roja directa cuenta como una.",
      opciones: [["0", 3.50], ["1", 2.80], ["2", 3.40], ["3 o más", 4.50]] },
    { clave: "tarjetas-linea", bloque: "Tarjetas", titulo: "Tarjetas: más o menos de 1,5", opciones: [["Menos de 1,5", 1.55], ["Más de 1,5", 2.30]] },
    { clave: "tarjetas-ambos", bloque: "Tarjetas", titulo: "Ambos equipos reciben tarjeta", opciones: [["Sí", 3.00], ["No", 1.35]] },
    { clave: "roja", bloque: "Tarjetas", titulo: "¿Hay tarjeta roja?", descripcion: "También cuenta la roja por doble amarilla.", opciones: [["Sí", 9.00], ["No", 1.05]] },
  ],
};

// Cuotas puestas a mano para un partido (clave = fecha; dentro, la clave del mercado y una cuota por opción, en orden)
const CUOTAS_FIJAS = {
  "2026-11-12": {
    resultado: [1.80, 3.20, 2.60],
    "primer-gol": {
      crispin: 1.60, zander: 2.80, abraham: 1.90, padilla: 2.10, alexis: 1.60, "alex-g": 2.40, pau: 2.00,
      samu: 4.20, "antonio-mc": 8.50, tito: 3.00, lorenzo: 3.20, francisco: 5.40, alonso: 20, dennis: 7.00,
      "d-escalona": 3.00, david: 8.40, "a-escalona": 3.80, nico: 20, "manuel-g": 20,
      sergio: 20, carlos: 10, alejandro: 20, gaizka: 15, emi: 7.00,
      ruben: 101, manuel: 101, "antonio-por": 101, adolfo: 101, Nadie: 8.50,
    },
    asistencia: {
      lorenzo: 1.60, samu: 3.20, "antonio-mc": 4.60, tito: 1.80, francisco: 2.10, alonso: 18, dennis: 4.80,
      abraham: 2.60, padilla: 3.00, alexis: 2.00, "alex-g": 4.00, pau: 1.80,
      "d-escalona": 1.40, david: 4.00, "a-escalona": 1.50, nico: 8.00, "manuel-g": 8.00,
      crispin: 2.60, zander: 3.20, sergio: 20, carlos: 15, alejandro: 20, gaizka: 20, emi: 13, Nadie: 10,
    },
    "portero-titular": { ruben: 2.40, "antonio-por": 2.80, manuel: 3.60, adolfo: 3.80 },
    // «¿Quién marca?»: el «Sí» de cada jugador es su cuota de primer goleador rebajada este porcentaje
    marcaDesdePrimerGol: 0.20,
    // Titular o suplente: probabilidad de ser titular según el entrenador (0 a 1), o [titular, suplente] a mano
    "titular-*": {
      // Porteros: «Titular» igual que en «¿Quién es el portero titular?»
      ruben: [2.40, 1.35], "antonio-por": [2.80, 1.25], manuel: [3.60, 1.15], adolfo: [3.80, 1.15],
      sergio: [6, 3], // viene de lesión
      carlos: 0.75, emi: 0.70, gaizka: 0.65, alejandro: 0.25,
      "d-escalona": 0.85, "a-escalona": 0.85, "manuel-g": 0.25, david: 0.12, nico: 0.12,
      lorenzo: 0.97, francisco: 0.85, tito: 0.50, alonso: 0.35,
    },
    // Convocado o desconvocado: probabilidad de ir convocado (0 a 1), o [convocado, desconvocado] a mano
    "convocado-*": {
      samu: 0.75, "antonio-mc": 0.50, tito: 0.70, alonso: 0.55,
      padilla: [1.85, 1.85], alexis: 0.97, "alex-g": [1.90, 2.10], pau: [1.40, 2.10],
    },
  },
};
// Mercados de convocatoria: se crean mientras no esté publicada la convocatoria de ese partido
const MAX_CONVOCADOS = 10; // a cuántos jugadores distintos puede apostar cada uno

const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = n => (Math.round(n) || 0).toLocaleString("es-ES");
const conSigno = n => (Math.round(n) > 0 ? "+" : "") + fmt(n);
const cuotaTxt = c => (Number(c) || 0).toFixed(2).replace(".", ",");
const fechaTxt = iso => new Date(iso).toLocaleString("es-ES", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const slug = s => String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const nuevoId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

let db = null, auth = null, uid = null, esAdmin = false, esAnonimo = true, conectado = false;
let mercados = [], porIdM = {}, votos = {}, cuentas = {}, legado = {};
let vista = "apostar", slip = [], stake = 10, simples = false, slipAbierto = false;
let resolviendo = null, borrando = null, editando = null;
const bloquesAbiertos = new Set();

try { const g = JSON.parse(localStorage.getItem("lb-boleto") || "{}"); slip = Array.isArray(g.slip) ? g.slip : []; stake = g.stake > 0 ? g.stake : 10; } catch (e) { /* sin almacenamiento */ }
function guardarSlip() { try { localStorage.setItem("lb-boleto", JSON.stringify({ slip, stake })); } catch (e) { /* sin almacenamiento */ } }

// ---------- Mercados ----------
const esCuotas = a => a && a.tipo === "cuotas";
const partidoDe = a => ({ id: a.partidoId || "general", nombre: a.partidoNombre || "Otras apuestas", fecha: a.partidoFecha || null });
function ganadoraDe(a) {
  if (a.estado === "resuelta" && Number.isInteger(a.ganadora)) return a.ganadora;
  if (esCuotas(a) || a.estado === "anulada" || !a.id.startsWith(LEGADO_PID + "-")) return undefined;
  const k = a.id.slice(LEGADO_PID.length + 1);
  const txt = k.startsWith("tit-") ? (LEGADO_TITULARES.includes(k.replace(/^tit-\d+-/, "")) ? "Titular" : "Suplente") : LEGADO_GANADORAS[k];
  const i = a.opciones.indexOf(txt);
  return i >= 0 ? i : undefined;
}
function estado(a) {
  if (a.estado === "anulada") return "anulada";
  if (ganadoraDe(a) !== undefined) return "resuelta";
  if (!esCuotas(a) || a.estado === "cerrada" || (a.cierre && new Date(a.cierre) <= new Date())) return "cerrada";
  return "abierta";
}
const horaDe = a => a.resuelta || a.cierre || "";
function ordenar(lista) {
  return [...lista].sort((a, b) => {
    const pa = partidoDe(a).fecha || "", pb = partidoDe(b).fecha || "";
    if (pa !== pb) return vista === "resultados" ? pb.localeCompare(pa) : pa.localeCompare(pb);
    if (typeof a.orden === "number" && typeof b.orden === "number" && a.orden !== b.orden) return a.orden - b.orden;
    return String(a.creada || "").localeCompare(String(b.creada || ""));
  });
}

// ---------- Cuentas ----------
const fichasDe = p => { const n = Math.floor(Number(p && p.fichas)); return n > 0 ? n : 0; };
const pickValido = (a, p) => p && fichasDe(p) > 0 && Number.isInteger(p.op) && p.op >= 0 && p.op < a.opciones.length;

// Sistema antiguo: los que acertaban se repartían el bote; si nadie acertaba, se devolvían las fichas.
function calcularLegado() {
  const res = {};
  for (const a of mercados) {
    if (esCuotas(a)) continue;
    const w = ganadoraDe(a), anulada = estado(a) === "anulada";
    if (w === undefined && !anulada) continue;
    const picks = []; let bote = 0, boteW = 0;
    for (const [u, d] of Object.entries(votos)) {
      const p = d && d.picks && d.picks[a.id];
      if (!pickValido(a, p)) continue;
      picks.push([u, p]); bote += fichasDe(p); if (p.op === w) boteW += fichasDe(p);
    }
    for (const [u, p] of picks) {
      const r = res[u] || (res[u] = { apostado: 0, cobrado: 0, detalle: [] });
      const f = fichasDe(p);
      r.apostado += f;
      const cobro = anulada || !boteW ? f : p.op === w ? Math.round(f * bote / boteW) : 0;
      r.cobrado += cobro;
      r.detalle.push({ a, op: p.op, f, cobro, acierto: !anulada && p.op === w });
    }
  }
  return res;
}

function boletoValido(b) {
  if (!b || !Array.isArray(b.sel) || !b.sel.length || b.sel.length > MAX_SELECCIONES) return false;
  if (!Number.isInteger(b.fichas) || b.fichas < 1) return false;
  const vistos = new Set();
  for (const s of b.sel) {
    const a = s && porIdM[s.a];
    if (!esCuotas(a) || vistos.has(s.a)) return false;
    vistos.add(s.a);
    if (!Number.isInteger(s.op) || s.op < 0 || s.op >= a.opciones.length) return false;
    const max = Number((a.cuotasMax || a.cuotas || [])[s.op]) || 0;
    if (!(s.c >= 1) || s.c > max + 1e-9) return false;
    if (a.cierre && typeof b.t === "string" && b.t > a.cierre) return false;
  }
  return true;
}
const cuotaTotal = sel => sel.reduce((x, s) => x * s.c, 1);
function evaluar(b) {
  let cuota = 1, pendiente = false, perdida = null, fin = "", anuladas = 0;
  const legs = b.sel.map(s => {
    const a = porIdM[s.a], e = estado(a);
    if (e === "anulada") { anuladas++; if (horaDe(a) > fin) fin = horaDe(a); return "anulada"; }
    if (e !== "resuelta") { pendiente = true; return "pendiente"; }
    if (ganadoraDe(a) === s.op) { cuota *= s.c; if (horaDe(a) > fin) fin = horaDe(a); return "ganada"; }
    if (perdida === null || horaDe(a) < perdida) perdida = horaDe(a);
    return "perdida";
  });
  if (perdida !== null) return { estado: "perdida", legs, cobro: 0, hora: perdida };
  if (pendiente) return { estado: "pendiente", legs, cobro: 0 };
  if (anuladas === b.sel.length) return { estado: "devuelta", legs, cobro: b.fichas, hora: fin };
  return { estado: "ganada", legs, cobro: Math.round(b.fichas * cuota), cuota, hora: fin };
}
// Recorre los boletos en orden y descarta los que se hicieron sin saldo suficiente en ese momento
function calcularCuenta(u) {
  const L = legado[u] || null;
  const base = SALDO_INICIAL + (L ? L.cobrado - L.apostado : 0);
  const lista = ((votos[u] && Array.isArray(votos[u].boletos)) ? votos[u].boletos : []).filter(boletoValido)
    .map(b => ({ b, r: evaluar(b) })).sort((x, y) => String(x.b.t).localeCompare(String(y.b.t)));
  const ok = [];
  for (const it of lista) {
    const t = String(it.b.t || "");
    let disp = base;
    for (const o of ok) { disp -= o.b.fichas; if (o.r.hora && o.r.hora <= t) disp += o.r.cobro; }
    if (it.b.fichas <= disp + 1e-6) ok.push(it); else it.r = { estado: "invalida", legs: it.b.sel.map(() => "anulada"), cobro: 0 };
  }
  let saldo = base, enJuego = 0, ganados = 0, jugados = 0;
  for (const o of ok) {
    saldo -= o.b.fichas;
    if (o.r.estado === "pendiente") enJuego += o.b.fichas;
    else { saldo += o.r.cobro; if (o.r.estado !== "devuelta") { jugados++; if (o.r.estado === "ganada") ganados++; } }
  }
  return { base, saldo, enJuego, total: saldo + enJuego, ganados, jugados, boletos: lista.reverse(), legado: L };
}
const apodoDe = u => (votos[u] && typeof votos[u].apodo === "string" && votos[u].apodo.trim().slice(0, 24)) || "";
const nombreDe = u => apodoDe(u) || "Anónimo";
const puedeApostar = () => !!(db && uid);
const miCuenta = () => (uid && cuentas[uid]) || { base: SALDO_INICIAL, saldo: SALDO_INICIAL, enJuego: 0, total: SALDO_INICIAL, ganados: 0, jugados: 0, boletos: [], legado: null };

// ---------- Generador de mercados con cuotas para el próximo partido ----------
function redondear(c) {
  c = Math.min(101, Math.max(1.05, c));
  if (c < 3) return Math.round(c * 20) / 20;
  if (c < 10) return Math.round(c * 10) / 10;
  return Math.round(c);
}
const deProb = (ps, margen) => ps.map(p => redondear(margen / Math.max(p, 0.004)));
const dosOpciones = (p, a = "Sí", b = "No") => { const [x, y] = deProb([p, 1 - p], 0.92); return [[a, x], [b, y]]; };

function proximoPartido() {
  if (typeof partidos === "undefined" || typeof porId === "undefined") return null;
  const p = partidos.filter(x => x.nuestros === null || x.nuestros === undefined).sort((a, b) => a.fecha.localeCompare(b.fecha))[0];
  if (!p) return null;
  const corto = (p.rival.match(/\(([^)]+)\)/) || [])[1] || p.rival.replace(/^Facultad de\s+/i, "");
  const conv = typeof convocatoria !== "undefined" && convocatoria.partido === p.fecha && convocatoria.jugadores.length > 0;
  const lista = conv ? convocatoria.jugadores.map(id => porId[id]).filter(Boolean) : [...jugadores];
  const cierre = new Date(`${p.fecha}T${p.hora || "00:00"}`).toISOString();
  return { p, corto, lista, conv, pid: `${p.fecha}-${slug(corto)}`, nombre: p.local ? `Laborales FC vs ${corto}` : `${corto} vs Laborales FC`, cierre };
}
const PESO_GOL = { "Delantero centro": 6, "Extremo": 4, "Centrocampista": 2.5, "Lateral derecho": 1.2, "Lateral izquierdo": 1.2, "Defensa central": 1, "Portero": 0.1 };
const PESO_ASIST = { "Delantero centro": 2, "Extremo": 3, "Centrocampista": 3, "Lateral derecho": 2, "Lateral izquierdo": 2, "Defensa central": 0.7, "Portero": 0.2 };
const GOLES_ESPERADOS = { "Delantero centro": 0.45, "Extremo": 0.3, "Centrocampista": 0.15, "Lateral derecho": 0.07, "Lateral izquierdo": 0.07, "Defensa central": 0.06 };
const porPartido = (j, k) => j.partidos ? Math.min(1, (j[k] || 0) / j.partidos) : 0;

function mercadosDe(c) {
  const base = { tipo: "cuotas", partidoId: c.pid, partidoNombre: c.nombre, partidoFecha: c.cierre, estado: "abierta", ganadora: null, cierre: c.cierre, creada: new Date().toISOString(), descripcion: "" };
  const L = [];
  const add = (clave, orden, titulo, pares, extra = {}) => {
    if (pares.length < 2) return;
    const cuotas = pares.map(x => x[1]);
    // "ids" guarda qué jugador es cada opción (hay nombres repetidos, como los dos Antonio)
    const ids = pares.some(x => x[2]) ? { ids: pares.map(x => x[2] || x[0]) } : {};
    L.push({ id: `${c.pid}-${clave}`, ...base, orden, titulo, opciones: pares.map(x => x[0]), cuotas, cuotasMax: cuotas, ...ids, ...extra });
  };
  const zip = (nombres, ps, m = 0.9) => { const cs = deProb(ps, m); return nombres.map((n, i) => [n, cs[i]]); };
  const proporcional = (lista, peso, resto, m) => {
    const w = lista.map(peso), s = w.reduce((x, y) => x + y, 0) || 1;
    const pares = zip(lista.map(j => j.nombre), w.map(x => (1 - resto[1]) * x / s), m).map((x, i) => [...x, lista[i].id]).sort((x, y) => x[1] - y[1]);
    return [...pares, [resto[0], deProb([resto[1]], m)[0]]];
  };
  const campo = c.lista.filter(j => j.posicion !== "Portero"), porteros = c.lista.filter(j => j.posicion === "Portero");

  add("resultado", 1, `Resultado: Laborales FC vs ${c.corto}`, zip(["Laborales FC", "Empate", c.corto], [0.5, 0.22, 0.28]));
  add("goles-laborales", 2, "¿Cuántos goles marca el Laborales?", zip(["0", "1", "2", "3", "4 o más"], [0.12, 0.25, 0.27, 0.19, 0.17]));
  add("goles-rival", 3, `¿Cuántos goles marca ${c.corto}?`, zip(["0", "1", "2", "3 o más"], [0.2, 0.3, 0.27, 0.23]));
  add("total", 4, "Goles totales del partido", dosOpciones(0.45, "Menos de 2,5", "Más de 2,5"));
  add("ambos", 5, "Ambos marcan", dosOpciones(0.55));
  add("primer-gol", 6, "¿Quién marca el primer gol del Laborales?", proporcional(c.lista, j => (PESO_GOL[j.posicion] || 1) * (1 + 1.5 * porPartido(j, "goles")), ["Nadie", 0.1], 0.85),
    { descripcion: "Si el Laborales no marca, gana «Nadie»." });
  add("asistencia", 7, "¿Quién da la primera asistencia?", proporcional(c.lista, j => (PESO_ASIST[j.posicion] || 1) * (1 + 1.5 * porPartido(j, "asistencias")), ["Nadie", 0.15], 0.85),
    { descripcion: "Si no hay ninguna asistencia, gana «Nadie»." });
  if (porteros.length >= 2) add("portero-titular", 8, "¿Quién es el portero titular?", proporcional(porteros, j => ((j.titular || 0) + 1) / ((j.partidos || 0) + 2), ["—", 0], 0.92).slice(0, -1));
  (EXTRAS[c.p.fecha] || []).forEach((e, i) => {
    const pares = e.opciones.map(o => Array.isArray(o) ? o : [o, null]);
    const igual = redondear(0.9 * pares.length);
    add(e.clave, e.orden ?? 20 + i, e.titulo, pares.map(([n, cu]) => [n, cu || igual]), { descripcion: e.descripcion || "", ...(e.bloque ? { bloque: e.bloque } : {}) });
  });
  campo.forEach((j, i) => {
    const l = (GOLES_ESPERADOS[j.posicion] || 0.1) * (1 + 1.5 * porPartido(j, "goles"));
    add(`marca-${j.id}`, 100 + i, `${j.nombre} marca`, dosOpciones(Math.min(0.8, 1 - Math.exp(-l))), { bloque: "¿Quién marca?" });
  });
  c.lista.forEach((j, i) => {
    add(`titular-${j.id}`, 200 + i, j.nombre, dosOpciones(((j.titular || 0) + 1) / ((j.partidos || 0) + 2), "Titular", "Suplente"),
      { bloque: "Titular o suplente", descripcion: "Si no va convocado, gana «Suplente»." });
  });
  if (!c.conv) {
    // Probabilidad de ir convocado según la asistencia a entrenamientos y partidos; se cierra la víspera a las 20:00
    const entrenos = typeof entrenamientos !== "undefined" ? entrenamientos.filter(e => Array.isArray(e.asistentes)) : [];
    const jugadosN = partidos.filter(p => p.nuestros !== null && p.nuestros !== undefined).length;
    const vispera = new Date(`${c.p.fecha}T20:00`); vispera.setDate(vispera.getDate() - 1);
    c.lista.forEach((j, i) => {
      const fueA = entrenos.filter(e => e.asistentes.includes(j.id)).length;
      const p = Math.min(0.9, Math.max(0.1, (fueA + 2 * (j.partidos || 0) + 1) / (entrenos.length + 2 * jugadosN + 2)));
      add(`convocado-${j.id}`, 300 + i, j.nombre, dosOpciones(p, "Convocado", "Desconvocado"),
        { bloque: "Convocados y desconvocados", maxPorPersona: MAX_CONVOCADOS, cierre: vispera.toISOString() });
    });
  }
  for (const [clave, cs] of Object.entries(CUOTAS_FIJAS[c.p.fecha] || {})) {
    if (clave === "marcaDesdePrimerGol") continue;
    if (clave.includes("*")) {
      for (const [jid, cu] of Object.entries(cs)) {
        const m = L.find(x => x.id === `${c.pid}-${clave.replace("*", jid)}`);
        if (!m) continue;
        // [cuota1, cuota2] = las dos a mano · número < 1 = probabilidad de la primera opción · número ≥ 1 = solo la primera
        m.cuotas = Array.isArray(cu) ? [...cu] : cu < 1 ? dosOpciones(cu).map(x => x[1]) : [cu, ...m.cuotas.slice(1)];
        m.cuotasMax = [...m.cuotas];
      }
      continue;
    }
    const m = L.find(x => x.id === `${c.pid}-${clave}`);
    if (!m) continue;
    if (Array.isArray(cs)) { if (cs.length === m.opciones.length) m.cuotas = [...cs]; }
    else {
      // Por jugador (id) o por nombre de opción; luego se ordena de favorito a menos favorito, «Nadie» al final
      m.cuotas = m.opciones.map((o, i) => cs[(m.ids || [])[i]] ?? cs[o] ?? m.cuotas[i]);
      if (m.ids) {
        const orden = m.opciones.map((o, i) => i).sort((x, y) => (m.ids[x] === "Nadie") - (m.ids[y] === "Nadie") || m.cuotas[x] - m.cuotas[y]);
        m.opciones = orden.map(i => m.opciones[i]); m.ids = orden.map(i => m.ids[i]); m.cuotas = orden.map(i => m.cuotas[i]);
      }
    }
    m.cuotasMax = [...m.cuotas];
  }
  const rebaja = (CUOTAS_FIJAS[c.p.fecha] || {}).marcaDesdePrimerGol;
  const primero = L.find(x => x.id === `${c.pid}-primer-gol`);
  if (rebaja && primero && primero.ids) {
    primero.ids.forEach((jid, i) => {
      const m = L.find(x => x.id === `${c.pid}-marca-${jid}`);
      if (!m) return;
      const si = redondear(primero.cuotas[i] * (1 - rebaja));
      const no = redondear(0.92 / Math.max(0.02, 1 - 0.92 / si)); // el «No» acorde con el «Sí»
      m.cuotas = [si, no]; m.cuotasMax = [si, no];
    });
  }
  return L;
}

// ---------- Pintar ----------
function render() {
  const foco = document.activeElement && document.activeElement.id;
  porIdM = Object.fromEntries(mercados.map(a => [a.id, a]));
  legado = calcularLegado();
  cuentas = {};
  for (const u of new Set([...Object.keys(votos), ...(uid ? [uid] : [])])) cuentas[u] = calcularCuenta(u);
  limpiarSlip();
  pintarCartera(); pintarVistas(); pintarMain(); pintarSlip(); pintarRanking(); pintarAdmin();
  if (foco && foco.startsWith("lb-") && $(foco) && document.activeElement !== $(foco)) $(foco).focus();
}

function pintarCartera() {
  const c = miCuenta();
  $("lb-w-saldo").textContent = fmt(c.saldo);
  $("lb-w-juego").textContent = fmt(c.enJuego);
  $("lb-w-beneficio").textContent = conSigno(c.total - SALDO_INICIAL);
  const input = $("lb-apodo");
  if (document.activeElement !== input) input.value = uid ? apodoDe(uid) : "";
  input.disabled = !puedeApostar();
  $("lb-apodo-btn").disabled = !puedeApostar();
}

const VISTAS = [["apostar", "Apostar"], ["mis", "Mis apuestas"], ["resultados", "Resultados"]];
function pintarVistas() {
  const n = {
    apostar: mercados.filter(a => estado(a) === "abierta").length,
    mis: miCuenta().boletos.filter(x => x.r.estado === "pendiente").length,
    resultados: mercados.filter(a => estado(a) !== "abierta").length,
  };
  $("lb-vistas").innerHTML = VISTAS.map(([k, t]) => `<button data-lb="vista" data-k="${k}" aria-pressed="${k === vista}">${t}${n[k] ? ` <small>${n[k]}</small>` : ""}</button>`).join("");
}

function pintarMain() {
  if (!conectado && !mercados.length) { $("lb-main").innerHTML = `<div class="lb-vacio"><strong>Cargando apuestas</strong>Aparecerán aquí en un momento.</div>`; return; }
  if (vista === "mis") { $("lb-main").innerHTML = pintarMias(); return; }
  const lista = ordenar(mercados.filter(a => vista === "apostar" ? estado(a) === "abierta" : estado(a) !== "abierta"));
  if (!lista.length) {
    $("lb-main").innerHTML = vista === "apostar"
      ? `<div class="lb-vacio"><strong>No hay apuestas abiertas</strong>Se abrirán antes del próximo partido. Mientras, mira tus apuestas o los resultados.</div>`
      : `<div class="lb-vacio"><strong>Aún no hay resultados</strong>Aquí saldrán los mercados cerrados y resueltos.</div>`;
    return;
  }
  const grupos = [];
  for (const a of lista) { const p = partidoDe(a); let g = grupos.find(x => x.p.id === p.id); if (!g) grupos.push(g = { p, items: [] }); g.items.push(a); }
  $("lb-main").innerHTML = grupos.map(g => {
    const legadoG = g.items.some(a => !esCuotas(a));
    const sub = vista === "apostar" ? `Cierra ${esc(fechaTxt(g.items[0].cierre || g.p.fecha))}` : legadoG ? "Sistema antiguo · bote compartido" : `${g.items.filter(a => estado(a) === "resuelta").length} de ${g.items.length} resueltos`;
    return `<div class="lb-grupo"><div class="lb-grupo-cab">
      <div><span class="etiqueta">${g.p.fecha ? esc(fechaTxt(g.p.fecha)) : "Apuestas"}</span><h3>${esc(g.p.nombre)}</h3></div>
      <span class="lb-grupo-sub">${sub}</span>
    </div>${piezasDe(g)}</div>`;
  }).join("");
}

function piezasDe(g) {
  const sueltos = g.items.filter(a => !a.bloque), bloques = [];
  for (const a of g.items.filter(a => a.bloque)) { let b = bloques.find(x => x.nombre === a.bloque); if (!b) bloques.push(b = { nombre: a.bloque, items: [] }); b.items.push(a); }
  return `${sueltos.length ? `<div class="lb-mercados">${sueltos.map(a => mercado(a)).join("")}</div>` : ""}
    ${bloques.map(b => {
      const clave = vista + "|" + g.p.id + "|" + b.nombre;
      const enBoleto = b.items.filter(a => slip.some(s => s.a === a.id)).length;
      const max = b.items[0].maxPorPersona, cierreB = b.items[0].cierre;
      const notas = [`${b.items.length} mercados`,
        max ? `máximo ${max} jugadores por persona${uid ? ` (llevas ${usadosEnBloque(b.nombre)})` : ""}` : "",
        vista === "apostar" && cierreB && cierreB !== g.items[0].cierre ? `cierra ${fechaTxt(cierreB)}` : "",
        enBoleto ? `${enBoleto} en tu boleto` : ""].filter(Boolean).join(" · ");
      return `<details class="lb-bloque" data-clave="${esc(clave)}" ${bloquesAbiertos.has(clave) ? "open" : ""}>
        <summary><span>${esc(b.nombre)}</span><small>${esc(notas)}</small></summary>
        <div class="lb-mercados lb-mini">${b.items.map(a => mercado(a, true)).join("")}</div>
      </details>`;
    }).join("")}`;
}

function pillDe(a) {
  const e = estado(a);
  if (e === "abierta") return "";
  if (e === "cerrada") return `<span class="lb-pill lb-cerrada">Esperando resultado</span>`;
  if (e === "anulada") return `<span class="lb-pill lb-gris">Anulado</span>`;
  return `<span class="lb-pill lb-ok">Resuelto</span>`;
}

// Quién ha apostado a cada opción (en boletos válidos)
function apostantes(a) {
  const por = a.opciones.map(() => []);
  for (const [u, c] of Object.entries(cuentas)) {
    for (const { b, r } of c.boletos) {
      if (r.estado === "invalida") continue;
      const s = b.sel.find(x => x.a === a.id);
      if (s && !por[s.op].includes(u)) por[s.op].push(u);
    }
    const p = votos[u] && votos[u].picks && votos[u].picks[a.id];
    if (!esCuotas(a) && pickValido(a, p) && !por[p.op].includes(u)) por[p.op].push(u);
  }
  return por;
}

function mercado(a, mini = false) {
  const e = estado(a), w = ganadoraDe(a), cuotas = esCuotas(a);
  const enSlip = slip.find(s => s.a === a.id);
  const quien = apostantes(a), total = quien.reduce((s, x) => s + x.length, 0);
  const ops = a.opciones.map((o, i) => {
    const clases = ["lb-op",
      enSlip && enSlip.op === i ? "lb-sel" : "",
      w === i ? "lb-ganadora" : "",
      e === "resuelta" && w !== i ? "lb-perdedora" : "",
      resolviendo === a.id ? "lb-elegible" : ""].join(" ");
    const accion = resolviendo === a.id ? `data-lb="ganar"` : e === "abierta" && cuotas ? `data-lb="sel"` : "";
    const cuota = editando === a.id
      ? `<input class="lb-cuota-input" type="number" min="1.01" step="0.05" value="${a.cuotas[i]}" data-cuota="${i}" aria-label="Cuota de ${esc(o)}">`
      : cuotas ? `<span class="lb-cuota">${cuotaTxt(a.cuotas[i])}</span>` : "";
    return editando === a.id
      ? `<label class="${clases}"><span class="lb-op-nombre">${esc(o)}</span>${cuota}</label>`
      : `<button class="${clases}" ${accion ? `${accion} data-a="${esc(a.id)}" data-i="${i}"` : "disabled"}><span class="lb-op-nombre">${esc(o)}</span>${cuota}</button>`;
  }).join("");
  const muchas = a.opciones.length > 5;
  const lista = total ? `<details class="lb-quien"><summary>Quién ha apostado (${total})</summary><ul>${a.opciones.map((o, i) => quien[i].length
    ? `<li><b>${esc(o)}:</b> ${quien[i].map(u => `<span class="lb-chip">${esc(nombreDe(u))}</span>`).join("")}</li>` : "").join("")}</ul></details>` : "";
  return `<article class="tarjeta lb-mercado${muchas && !mini ? " lb-ancho" : ""}" data-m="${esc(a.id)}">
    <div class="lb-m-cab"><h4>${esc(a.titulo)}</h4>${pillDe(a)}</div>
    ${a.descripcion ? `<p class="lb-desc">${esc(a.descripcion)}</p>` : ""}
    <div class="lb-ops${muchas ? " lb-muchas" : ""}">${ops}</div>
    ${lista}${esAdmin && cuotas ? adminFila(a) : ""}
  </article>`;
}

function adminFila(a) {
  const e = estado(a);
  let b;
  if (borrando === a.id) b = `<span>¿Borrar este mercado? Los boletos que lo lleven dejarán de contar.</span><button class="lb-btn lb-peligro" data-lb="borrar-si" data-a="${esc(a.id)}">Sí, borrar</button><button class="lb-btn" data-lb="borrar-no">No</button>`;
  else if (resolviendo === a.id) b = `<span>Toca la opción ganadora.</span><button class="lb-btn" data-lb="resolver-no">Cancelar</button>`;
  else if (editando === a.id) b = `<button class="lb-btn lb-primario" data-lb="cuotas-ok" data-a="${esc(a.id)}">Guardar cuotas</button><button class="lb-btn" data-lb="cuotas-no">Cancelar</button>`;
  else b = [
    e === "abierta" ? `<button class="lb-btn" data-lb="cuotas" data-a="${esc(a.id)}">Cuotas</button>` : "",
    e === "abierta" ? `<button class="lb-btn" data-lb="cerrar" data-a="${esc(a.id)}">Cerrar</button>` : "",
    e !== "abierta" ? `<button class="lb-btn" data-lb="reabrir" data-a="${esc(a.id)}">Reabrir</button>` : "",
    e !== "anulada" ? `<button class="lb-btn lb-primario" data-lb="resolver" data-a="${esc(a.id)}">${e === "resuelta" ? "Cambiar ganadora" : "Ganadora"}</button>` : "",
    e !== "anulada" ? `<button class="lb-btn" data-lb="anular" data-a="${esc(a.id)}">Anular</button>` : "",
    `<button class="lb-btn lb-peligro" data-lb="borrar" data-a="${esc(a.id)}">Borrar</button>`].join("");
  return `<div class="lb-admin-fila">${b}</div>`;
}

const ESTADO_TXT = { pendiente: ["lb-cerrada", "En juego"], ganada: ["lb-ok", "Ganada"], perdida: ["lb-mal", "Perdida"], devuelta: ["lb-gris", "Devuelta"], invalida: ["lb-gris", "No válida"] };
const ICONO = { ganada: ["lb-ico-ok", "✓"], perdida: ["lb-ico-ko", "✗"], pendiente: ["lb-ico-pend", "•"], anulada: ["lb-ico-pend", "–"] };
function pintarMias() {
  if (!uid) return `<div class="lb-vacio"><strong>Conectando…</strong>En un momento verás tus apuestas.</div>`;
  const c = miCuenta();
  const tickets = c.boletos.map(({ b, r }) => {
    const [cls, txt] = ESTADO_TXT[r.estado];
    const cuota = cuotaTotal(b.sel);
    const pie = r.estado === "ganada" ? `Cobrado <b class="lb-ganancia">${fmt(r.cobro)}</b>`
      : r.estado === "devuelta" ? `Devuelto <b>${fmt(r.cobro)}</b>`
      : r.estado === "perdida" ? `Cobrado <b>0</b>`
      : r.estado === "invalida" ? `No contó: no había saldo o llegó tarde`
      : `Posible ganancia <b class="lb-ganancia">${fmt(b.fichas * cuota)}</b>`;
    return `<article class="tarjeta lb-ticket lb-t-${r.estado}">
      <div class="lb-t-cab"><b>${b.sel.length > 1 ? `Combinada · ${b.sel.length}` : "Simple"}</b><span class="lb-pill ${cls}">${txt}</span></div>
      <ul class="lb-t-sels">${b.sel.map((s, i) => {
        const a = porIdM[s.a], [ic, sim] = ICONO[r.legs[i]] || ICONO.pendiente;
        return `<li><span class="${ic}">${sim}</span><div><b>${esc(a.opciones[s.op])}</b><small>${esc(a.titulo)} · ${esc(partidoDe(a).nombre)}</small></div><span class="lb-cuota">${cuotaTxt(s.c)}</span></li>`;
      }).join("")}</ul>
      <div class="lb-t-pie"><span>Apostado <b>${fmt(b.fichas)}</b></span><span>Cuota <b>${cuotaTxt(cuota)}</b></span><span>${pie}</span></div>
      <small class="lb-t-fecha">${b.t ? esc(fechaTxt(b.t)) : ""}</small>
    </article>`;
  }).join("");
  const L = c.legado;
  const viejo = L ? `<article class="tarjeta lb-ticket lb-t-${L.cobrado >= L.apostado ? "ganada" : "perdida"}">
      <div class="lb-t-cab"><b>Amistoso vs RESA · sistema antiguo</b><span class="lb-pill ${L.cobrado >= L.apostado ? "lb-ok" : "lb-mal"}">${conSigno(L.cobrado - L.apostado)}</span></div>
      <ul class="lb-t-sels">${L.detalle.map(d => `<li><span class="${d.acierto ? "lb-ico-ok" : "lb-ico-ko"}">${d.acierto ? "✓" : "✗"}</span><div><b>${esc(d.a.opciones[d.op])}</b><small>${esc(d.a.titulo)}</small></div><span class="lb-cuota">${fmt(d.f)}</span></li>`).join("")}</ul>
      <div class="lb-t-pie"><span>Apostado <b>${fmt(L.apostado)}</b></span><span>Cobrado <b>${fmt(L.cobrado)}</b></span><span>Empezaste con <b>${fmt(c.base)}</b></span></div>
    </article>` : "";
  if (!tickets && !viejo) return `<div class="lb-vacio"><strong>Aún no has apostado</strong>Ve a «Apostar», toca una cuota y se añadirá a tu boleto.</div>`;
  return `<div class="lb-tickets">${tickets}${viejo}</div>`;
}

// ---------- Boleto ----------
// Mercados distintos de un bloque que ya tengo apostados o en el boleto
function usadosEnBloque(bloque, sinId) {
  const ids = new Set(slip.map(s => s.a));
  for (const { b, r } of miCuenta().boletos) if (r.estado !== "invalida") b.sel.forEach(s => ids.add(s.a));
  ids.delete(sinId);
  return [...ids].filter(id => porIdM[id] && porIdM[id].bloque === bloque).length;
}
function pasaDelMaximo() {
  const bloques = new Set(slip.map(s => porIdM[s.a]).filter(a => a && a.maxPorPersona).map(a => a.bloque));
  for (const bl of bloques) {
    const max = mercados.find(a => a.bloque === bl && a.maxPorPersona).maxPorPersona;
    if (usadosEnBloque(bl) > max) return `En «${bl}» puedes apostar como mucho a ${max} jugadores.`;
  }
  return "";
}
function limpiarSlip() {
  if (!conectado) return; // hasta que lleguen los mercados no se sabe qué sigue abierto
  const antes = slip.length;
  slip = slip.filter(s => { const a = porIdM[s.a]; return a && esCuotas(a) && estado(a) === "abierta" && s.op < a.opciones.length; });
  if (slip.length !== antes && mercados.length) guardarSlip();
  if (!slip.length) slipAbierto = false;
}
function resumenSlip() {
  const sels = slip.filter(s => porIdM[s.a]).map(s => { const a = porIdM[s.a]; return { a, op: s.op, c: a.cuotas[s.op] }; });
  const separadas = simples && sels.length > 1;
  const s = Math.max(0, Math.floor(stake) || 0);
  const totalApostado = separadas ? s * sels.length : s;
  const cuota = cuotaTotal(sels);
  const ganancia = separadas ? sels.reduce((x, y) => x + s * y.c, 0) : s * cuota;
  return { sels, separadas, s, totalApostado, cuota, ganancia };
}
function pintarSlip() {
  const el = $("lb-slip"), r = resumenSlip(), c = miCuenta();
  if (!conectado) { el.classList.add("lb-slip-vacia"); el.innerHTML = ""; return; }
  el.classList.toggle("lb-slip-vacia", !slip.length);
  el.classList.toggle("lb-abierto", slipAbierto);
  document.body.classList.toggle("lb-con-boleto", slip.length > 0);
  const cab = `<button type="button" class="lb-slip-cab" data-lb="slip-toggle" aria-expanded="${slipAbierto}">
    <b>Boleto</b>${slip.length ? `<span class="lb-badge">${slip.length}</span>` : ""}
    <span class="lb-slip-cuota">${slip.length ? (r.separadas ? `${slip.length} simples` : `Cuota ${cuotaTxt(r.cuota)}`) : ""}</span><span class="lb-slip-flecha" aria-hidden="true">${slipAbierto ? "▾" : "▴"}</span></button>`;
  if (!slip.length) { el.innerHTML = cab + `<div class="lb-slip-cuerpo"><p class="lb-slip-vacio">Toca una cuota para añadirla. Si eliges varias de distintos mercados, haces una combinada: las cuotas se multiplican.</p></div>`; return; }
  const falta = !apodoDe(uid) ? "Ponte un apodo arriba para poder apostar." : r.totalApostado > c.saldo ? `No te llega: tienes ${fmt(c.saldo)} fichas.` : "";
  el.innerHTML = cab + `<div class="lb-slip-cuerpo">
    <ul class="lb-sels">${r.sels.map((x, i) => `<li><div><b>${esc(x.a.opciones[x.op])}</b><small>${esc(x.a.titulo)}</small></div><span class="lb-cuota">${cuotaTxt(x.c)}</span><button class="lb-quitar" data-lb="quitar" data-i="${i}" aria-label="Quitar">✕</button></li>`).join("")}</ul>
    ${slip.length > 1 ? `<div class="lb-modo"><button data-lb="modo" data-v="0" aria-pressed="${!simples}">Combinada</button><button data-lb="modo" data-v="1" aria-pressed="${simples}">Simples</button></div>` : ""}
    <div class="lb-stake">
      <input id="lb-stake" type="number" inputmode="numeric" min="1" step="1" value="${r.s || ""}" data-lb="stake" aria-label="Fichas${r.separadas ? " por apuesta" : ""}">
      ${[10, 50, 100].map(v => `<button class="lb-rapido" data-lb="rapido" data-v="${v}">${v}</button>`).join("")}
      <button class="lb-rapido" data-lb="rapido" data-v="todo">Todo</button>
    </div>
    <div class="lb-resumen" id="lb-resumen">${resumenTxt(r)}</div>
    <p class="lb-slip-aviso" id="lb-slip-aviso" ${falta ? "" : "hidden"}>${esc(falta)}</p>
    <button class="lb-btn lb-primario lb-btn-ancho" data-lb="apostar" id="lb-apostar" ${!puedeApostar() ? "disabled" : ""}>${botonTxt(r)}</button>
    <button class="lb-acceso" data-lb="vaciar" type="button">Vaciar boleto</button>
  </div>`;
}
const resumenTxt = r => `${r.separadas ? `<div><span>Apuestas</span><b>${r.sels.length} × ${fmt(r.s)}</b></div>` : `<div><span>Cuota ${r.sels.length > 1 ? "combinada" : ""}</span><b>${cuotaTxt(r.cuota)}</b></div>`}
  <div><span>Apuestas en total</span><b>${fmt(r.totalApostado)}</b></div>
  <div><span>${r.separadas ? "Si aciertas todas" : "Si aciertas"} cobras</span><b class="lb-ganancia">${fmt(r.ganancia)}</b></div>`;
const botonTxt = r => `Apostar ${fmt(r.totalApostado)} fichas`;
function refrescarResumen() {
  const r = resumenSlip(), c = miCuenta();
  if ($("lb-resumen")) $("lb-resumen").innerHTML = resumenTxt(r);
  if ($("lb-apostar")) $("lb-apostar").textContent = botonTxt(r);
  const falta = !apodoDe(uid) ? "Ponte un apodo arriba para poder apostar." : r.totalApostado > c.saldo ? `No te llega: tienes ${fmt(c.saldo)} fichas.` : "";
  if ($("lb-slip-aviso")) { $("lb-slip-aviso").textContent = falta; $("lb-slip-aviso").hidden = !falta; }
}

function pintarRanking() {
  const ids = Object.keys(cuentas).filter(u => apodoDe(u) || u === uid);
  if (!ids.length) { $("lb-ranking").innerHTML = `<li class="lb-nadie">Todavía no hay nadie.</li>`; return; }
  const filas = ids.map(u => ({ u, ...cuentas[u] })).sort((x, y) => y.total - x.total || y.ganados - x.ganados);
  $("lb-ranking").innerHTML = filas.map((f, i) => `<li class="${f.u === uid ? "lb-yo" : ""}">
    <span class="lb-pos">${i + 1}</span>
    <span class="lb-quien-r"><b>${esc(f.u === uid && !apodoDe(uid) ? "Tú (sin apodo)" : nombreDe(f.u))}${i === 0 && filas.length > 1 ? `<span class="lb-tag lb-lider">Líder</span>` : ""}${i === filas.length - 1 && filas.length >= 3 ? `<span class="lb-tag lb-farolillo">Farolillo rojo</span>` : ""}${f.u === uid ? `<span class="lb-tag lb-tu">Tú</span>` : ""}</b>
      <small>${f.enJuego ? `${fmt(f.enJuego)} en juego · ` : ""}${f.jugados ? `${f.ganados}/${f.jugados} boletos ganados` : f.legado ? "Viene del amistoso" : "Sin apuestas todavía"}</small></span>
    <span class="lb-saldo">${fmt(f.total)}<small>fichas</small></span>
  </li>`).join("");
}

function pintarAdmin() {
  $("lb-admin").hidden = !esAdmin;
  $("lb-acceso").textContent = esAnonimo ? "Acceso organizador" : "Salir del modo organizador";
  if (!esAdmin) return;
  const c = proximoPartido();
  if (!c) { $("lb-gen-texto").textContent = "No hay ningún partido pendiente en la web."; $("lb-gen").disabled = true; }
  else {
    const nuevas = mercadosDe(c).filter(x => !porIdM[x.id]);
    $("lb-gen-texto").textContent = nuevas.length
      ? `${c.nombre}: se crearán ${nuevas.length} mercados con cuotas usando ${c.conv ? `los ${c.lista.length} convocados` : `toda la plantilla (aún no hay convocatoria para este partido)`}.`
      : `${c.nombre}: los mercados de este partido ya están creados.`;
    $("lb-gen").disabled = !nuevas.length;
  }
  $("lb-lista-partidos").innerHTML = [...new Set(mercados.filter(esCuotas).map(a => partidoDe(a).nombre))].map(n => `<option value="${esc(n)}"></option>`).join("");
}

// ---------- Escrituras ----------
let toastT;
function toast(t) { const el = $("lb-toast"); el.textContent = t; el.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => el.hidden = true, 2800); }
function aviso(t) { $("lb-aviso").textContent = t || ""; $("lb-aviso").hidden = !t; }
function fallo(e) {
  console.error(e);
  if (e && e.code === "permission-denied") toast("No tienes permiso para hacer eso.");
  else toast("No se ha podido guardar. Revisa la conexión y prueba otra vez.");
}
let cola = Promise.resolve();
function guardarMio(cambio, ok) {
  cola = cola.then(async () => {
    const actual = votos[uid] ? JSON.parse(JSON.stringify(votos[uid])) : {};
    const nuevo = cambio({ apodo: actual.apodo || "", picks: actual.picks || {}, boletos: Array.isArray(actual.boletos) ? actual.boletos : [] });
    await setDoc(doc(db, "votos", uid), nuevo);
    if (ok) toast(ok);
    return true;
  }).catch(e => { fallo(e); return false; });
  return cola;
}
async function cambiarMercado(id, datos, ok) {
  try { await updateDoc(doc(db, "apuestas", id), datos); if (ok) toast(ok); } catch (e) { fallo(e); }
}

function apostar() {
  const r = resumenSlip(), c = miCuenta();
  if (!puedeApostar()) return;
  if (!apodoDe(uid)) { toast("Antes de apostar, ponte un apodo arriba."); $("lb-apodo").focus(); return; }
  if (!r.sels.length) return;
  if (r.s < 1) { toast("Pon al menos 1 ficha."); return; }
  if (r.totalApostado > c.saldo) { toast(`No te llega el saldo: tienes ${fmt(c.saldo)} fichas.`); return; }
  if (r.sels.some(x => estado(x.a) !== "abierta")) { toast("Algún mercado ya se ha cerrado."); render(); return; }
  const tope = pasaDelMaximo();
  if (tope) { toast(tope); return; }
  const t = new Date().toISOString();
  const grupos = r.separadas ? r.sels.map(x => [x]) : [r.sels];
  const nuevos = grupos.map(g => ({ id: nuevoId(), t, fichas: r.s, sel: g.map(x => ({ a: x.a.id, op: x.op, c: x.c })) }));
  const msg = r.separadas ? `${nuevos.length} apuestas simples hechas` : r.sels.length > 1 ? `Combinada de ${r.sels.length} hecha · cuota ${cuotaTxt(r.cuota)}` : `Apuesta hecha · cuota ${cuotaTxt(r.cuota)}`;
  $("lb-apostar").disabled = true;
  guardarMio(d => { d.boletos = [...d.boletos, ...nuevos]; return d; }, msg).then(ok => {
    if (ok) { slip = []; slipAbierto = false; guardarSlip(); }
    render();
  });
}

// ---------- Eventos ----------
function enlazarEventos() {
  $("lb").addEventListener("click", ev => {
    const b = ev.target.closest("[data-lb]");
    if (!b || b.tagName === "INPUT") return;
    const acc = b.dataset.lb, a = porIdM[b.dataset.a];
    switch (acc) {
      case "vista": vista = b.dataset.k; resolviendo = editando = borrando = null; render(); break;
      case "sel": {
        const i = +b.dataset.i, ya = slip.findIndex(s => s.a === a.id);
        if (ya >= 0 && slip[ya].op === i) slip.splice(ya, 1);
        else if (ya >= 0) slip[ya] = { a: a.id, op: i };
        else if (slip.length >= MAX_SELECCIONES) { toast(`Máximo ${MAX_SELECCIONES} selecciones por boleto.`); break; }
        else if (a.maxPorPersona && usadosEnBloque(a.bloque, a.id) >= a.maxPorPersona) { toast(`En «${a.bloque}» puedes apostar como mucho a ${a.maxPorPersona} jugadores.`); break; }
        else slip.push({ a: a.id, op: i });
        guardarSlip(); render(); break;
      }
      case "quitar": slip.splice(+b.dataset.i, 1); guardarSlip(); render(); break;
      case "vaciar": slip = []; guardarSlip(); render(); break;
      case "modo": simples = b.dataset.v === "1"; render(); break;
      case "rapido": stake = b.dataset.v === "todo" ? Math.max(0, Math.floor(miCuenta().saldo / (simples && slip.length > 1 ? slip.length : 1))) : +b.dataset.v; guardarSlip(); render(); break;
      case "slip-toggle": if (slip.length) { slipAbierto = !slipAbierto; pintarSlip(); } break;
      case "apostar": apostar(); break;
      case "cerrar": cambiarMercado(a.id, { estado: "cerrada" }, "Mercado cerrado"); break;
      case "reabrir": cambiarMercado(a.id, { estado: "abierta", ganadora: null, resuelta: null, cierre: null }, "Mercado reabierto"); break;
      case "resolver": resolviendo = a.id; editando = borrando = null; render(); break;
      case "resolver-no": resolviendo = null; render(); break;
      case "ganar": resolviendo = null; cambiarMercado(a.id, { estado: "resuelta", ganadora: +b.dataset.i, resuelta: new Date().toISOString() }, `Gana ${a.opciones[+b.dataset.i]}`); break;
      case "anular": cambiarMercado(a.id, { estado: "anulada", ganadora: null, resuelta: new Date().toISOString() }, "Mercado anulado: cuenta como cuota 1"); break;
      case "cuotas": editando = a.id; resolviendo = borrando = null; render(); break;
      case "cuotas-no": editando = null; render(); break;
      case "cuotas-ok": {
        const inputs = [...document.querySelectorAll(`[data-m="${CSS.escape(a.id)}"] [data-cuota]`)];
        const nuevas = inputs.map(x => Math.round(Number(x.value) * 100) / 100);
        if (nuevas.length !== a.opciones.length || nuevas.some(x => !(x >= 1.01))) { toast("Todas las cuotas tienen que ser 1,01 o más."); break; }
        const max = nuevas.map((x, i) => Math.max(x, Number((a.cuotasMax || a.cuotas)[i]) || 0));
        editando = null;
        cambiarMercado(a.id, { cuotas: nuevas, cuotasMax: max }, "Cuotas actualizadas");
        break;
      }
      case "borrar": borrando = a.id; render(); break;
      case "borrar-no": borrando = null; render(); break;
      case "borrar-si": borrando = null; deleteDoc(doc(db, "apuestas", a.id)).then(() => toast("Mercado borrado"), fallo); break;
    }
  });
  $("lb").addEventListener("input", ev => {
    if (ev.target.id === "lb-stake") { stake = Math.floor(Number(ev.target.value)) || 0; guardarSlip(); refrescarResumen(); }
  });
  $("lb").addEventListener("toggle", ev => {
    const d = ev.target;
    if (d.classList && d.classList.contains("lb-bloque")) { if (d.open) bloquesAbiertos.add(d.dataset.clave); else bloquesAbiertos.delete(d.dataset.clave); }
  }, true);
  $("lb-form-apodo").addEventListener("submit", ev => {
    ev.preventDefault();
    if (!puedeApostar()) return;
    const v = $("lb-apodo").value.trim().slice(0, 24);
    if (!v) { toast("Escribe un apodo."); return; }
    if (Object.keys(votos).some(u => u !== uid && apodoDe(u).toLowerCase() === v.toLowerCase())) { toast("Ese apodo ya lo tiene otro. Elige otro."); return; }
    guardarMio(d => { d.apodo = v; return d; }, `Ahora eres ${v}`);
    $("lb-apodo").blur();
  });
  $("lb-acceso").addEventListener("click", async () => {
    if (!auth) return;
    try {
      if (esAnonimo) await signInWithPopup(auth, new GoogleAuthProvider());
      else await signOut(auth);
    } catch (e) { if (e && e.code !== "auth/popup-closed-by-user") toast("No se ha podido iniciar sesión."); }
  });
  $("lb-gen").addEventListener("click", async () => {
    const c = proximoPartido(); if (!c) return;
    const nuevas = mercadosDe(c).filter(x => !porIdM[x.id]);
    if (!nuevas.length) return;
    const lote = writeBatch(db);
    nuevas.forEach(({ id, ...datos }) => lote.set(doc(db, "apuestas", id), datos));
    try { await lote.commit(); toast(`${nuevas.length} mercados creados`); vista = "apostar"; render(); } catch (e) { fallo(e); }
  });
  $("lb-form-crear").addEventListener("submit", async ev => {
    ev.preventDefault();
    const titulo = $("lb-c-titulo").value.trim();
    const pares = $("lb-c-opciones").value.split("\n").map(l => l.split("|").map(x => x.trim())).filter(x => x[0])
      .map(([n, c]) => [n, Math.round(Number(String(c || "").replace(",", ".")) * 100) / 100]);
    const nombres = [...new Set(pares.map(x => x[0]))];
    if (!titulo || nombres.length < 2 || nombres.length !== pares.length) { toast("Hace falta una pregunta y al menos 2 opciones distintas."); return; }
    if (pares.some(x => !(x[1] >= 1.01))) { toast("Pon una cuota a cada opción, así: Emi | 2,5"); return; }
    const cie = $("lb-c-cierre").value, partidoNombre = $("lb-c-partido").value.trim();
    const existente = mercados.filter(esCuotas).map(partidoDe).find(p => p.nombre.toLowerCase() === partidoNombre.toLowerCase());
    const cierre = cie ? new Date(cie).toISOString() : (existente && existente.fecha) || null;
    const cuotas = pares.map(x => x[1]);
    try {
      await addDoc(collection(db, "apuestas"), {
        tipo: "cuotas", titulo, descripcion: $("lb-c-desc").value.trim(), opciones: nombres, cuotas, cuotasMax: cuotas,
        estado: "abierta", ganadora: null, cierre, creada: new Date().toISOString(), orden: 50,
        partidoId: existente ? existente.id : (slug(partidoNombre) || "general"), partidoNombre: existente ? existente.nombre : partidoNombre, partidoFecha: existente ? existente.fecha : cierre,
      });
      $("lb-c-titulo").value = ""; $("lb-c-desc").value = ""; $("lb-c-opciones").value = ""; toast("Mercado publicado");
    } catch (e) { fallo(e); }
  });
}

// ---------- Arranque ----------
function arrancar() {
  enlazarEventos();
  const configurado = !!(firebaseConfig && firebaseConfig.apiKey && !String(firebaseConfig.apiKey).startsWith("PEGA"));
  if (!configurado) { aviso("LaboralesBet se está preparando. Vuelve en un rato."); render(); return; }
  const app = initializeApp(firebaseConfig);
  auth = getAuth(app); db = getFirestore(app);
  render();
  onAuthStateChanged(auth, async u => {
    if (!u) { try { await signInAnonymously(auth); } catch (e) { console.error(e); aviso("No se ha podido conectar con LaboralesBet. Recarga la página."); } return; }
    uid = u.uid; esAnonimo = u.isAnonymous; esAdmin = false;
    if (!u.isAnonymous) {
      try { await getDoc(doc(db, "admin", "check")); esAdmin = true; }
      catch (e) { toast("Esta cuenta no es la del organizador."); }
    }
    render();
  });
  const espera = setTimeout(() => { if (!conectado) aviso("No se pueden cargar las apuestas todavía. Revisa la conexión."); }, 10000);
  const listo = () => { if (!conectado) { conectado = true; clearTimeout(espera); aviso(""); } };
  const error = e => { console.error(e); clearTimeout(espera); aviso("Se ha perdido la conexión con las apuestas. Recarga la página."); };
  onSnapshot(collection(db, "apuestas"), s => {
    mercados = s.docs.map(d => ({ id: d.id, ...d.data() })).filter(a => typeof a.titulo === "string" && Array.isArray(a.opciones) && a.opciones.length >= 2
      && (!esCuotas(a) || (Array.isArray(a.cuotas) && a.cuotas.length === a.opciones.length)));
    listo(); render();
  }, error);
  onSnapshot(collection(db, "votos"), s => {
    votos = {}; s.docs.forEach(d => { votos[d.id] = d.data(); });
    listo(); render();
  }, error);
  // Los mercados se cierran solos al empezar el partido
  setInterval(() => { if (mercados.some(a => esCuotas(a) && a.cierre && a.estado === "abierta")) render(); }, 30000);
}
arrancar();
