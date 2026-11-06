// LaboralesBet: apuestas de broma con fichas, sin dinero.
// Los datos se guardan en Firebase (Firestore). La configuración va en firebase-config.js.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, collection, doc, onSnapshot, setDoc, updateDoc, deleteDoc, addDoc, getDoc, writeBatch } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const FICHAS = 1000;

// Apuestas especiales de un partido concreto (clave = fecha del partido).
// Se añaden a las típicas al pulsar "Crear apuestas del partido".
const EXTRAS = {
  "2026-11-06": [
    { clave: "agresion", orden: 8, titulo: "¿Quién la lía primero: Emi o Gaizka?", descripcion: "Primera entrada fea, tarjeta o pique gordo con un rival.", opciones: ["Emi", "Gaizka", "Los dos", "Ninguno, partido de guante blanco"] },
    { clave: "fuera-juego", orden: 9, titulo: "¿Cuántos fueras de juego le pitan a Crispín?", opciones: ["0", "1", "2", "3", "4 o más"] },
    { clave: "velocidad", orden: 10, titulo: "¿Qué Escalona alcanza la velocidad máxima?", descripcion: "El sprint más rápido de los dos hermanos en el partido.", opciones: ["D. Escalona", "A. Escalona"] },
  ],
};

const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = n => (Math.round(n) || 0).toLocaleString("es-ES");
const conSigno = n => (Math.round(n) > 0 ? "+" : "") + fmt(n);
const cuotaTxt = c => c ? c.toFixed(2).replace(".", ",") : "—";
const fechaTxt = iso => new Date(iso).toLocaleString("es-ES", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const slug = s => String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

let db = null, auth = null, uid = null, esAdmin = false, esAnonimo = true, conectado = false, configurado = false;
let apuestas = [], votos = {};
let filtro = "todas", sel = null, stake = 100, resolviendo = null, borrando = null;
const bloquesAbiertos = new Set();

// ---------- Cálculos ----------
function estadoDe(a) {
  if (a.estado === "resuelta" || a.estado === "anulada") return a.estado;
  if (a.estado === "cerrada" || (a.cierre && new Date(a.cierre) <= new Date())) return "cerrada";
  return "abierta";
}
const fichasDe = p => { const n = Math.floor(Number(p && p.fichas)); return n > 0 ? n : 0; };
const pickValido = (a, p) => p && fichasDe(p) > 0 && Number.isInteger(p.op) && p.op >= 0 && p.op < a.opciones.length;
const partidoDe = a => ({ id: a.partidoId || "general", nombre: a.partidoNombre || "Otras apuestas", fecha: a.partidoFecha || null });
function botes(a, sinUid) {
  const pool = a.opciones.map(() => 0), gente = a.opciones.map(() => []);
  let total = 0;
  for (const [u, d] of Object.entries(votos)) {
    if (u === sinUid) continue;
    const p = d && d.picks && d.picks[a.id];
    if (!pickValido(a, p)) continue;
    pool[p.op] += fichasDe(p); total += fichasDe(p); gente[p.op].push({ u, f: fichasDe(p) });
  }
  return { pool, total, gente };
}
function gastadoEn(u, pid, sinId) {
  const d = votos[u]; let s = 0;
  for (const a of apuestas) {
    if (a.id === sinId || partidoDe(a).id !== pid || estadoDe(a) === "anulada") continue;
    const p = d && d.picks && d.picks[a.id];
    if (pickValido(a, p)) s += fichasDe(p);
  }
  return s;
}
function cartera(u) {
  const d = votos[u];
  let beneficio = 0, aciertos = 0, jugadas = 0, enJuego = 0;
  for (const a of apuestas) {
    const p = d && d.picks && d.picks[a.id];
    if (!pickValido(a, p)) continue;
    const e = estadoDe(a), f = fichasDe(p);
    if (e === "anulada") continue;
    if (e === "resuelta") {
      const { pool, total } = botes(a);
      if (!pool[a.ganadora]) continue; // nadie acertó: se devuelve
      jugadas++;
      if (p.op === a.ganadora) { beneficio += f * total / pool[a.ganadora] - f; aciertos++; }
      else beneficio -= f;
    } else enJuego += f;
  }
  return { beneficio, aciertos, jugadas, enJuego };
}
const miPick = a => { const p = uid && votos[uid] && votos[uid].picks && votos[uid].picks[a.id]; return pickValido(a, p) ? p : null; };
const disponiblePara = a => Math.max(0, FICHAS - gastadoEn(uid, partidoDe(a).id, a.id));
function cobroPosible(a, op, f) { const { pool, total } = botes(a, uid); return f * (total + f) / (pool[op] + f); }
const apodoDe = u => (votos[u] && typeof votos[u].apodo === "string" && votos[u].apodo.trim().slice(0, 24)) || "";
const nombreDe = u => apodoDe(u) || "Anónimo";
const puedeApostar = () => !!(db && uid);

const RANGO = { abierta: 0, cerrada: 1, resuelta: 2, anulada: 2 };
function ordenadas() {
  return [...apuestas].sort((a, b) => {
    const r = RANGO[estadoDe(a)] - RANGO[estadoDe(b)];
    if (r) return r;
    if (estadoDe(a) === "abierta") { const c = (a.cierre || "9999").localeCompare(b.cierre || "9999"); if (c) return c; }
    if (typeof a.orden === "number" && typeof b.orden === "number" && a.orden !== b.orden) return a.orden - b.orden;
    return String(b.creada || "").localeCompare(String(a.creada || ""));
  });
}
function partidoActual() { const ab = ordenadas().find(a => estadoDe(a) === "abierta"); return ab ? partidoDe(ab) : null; }

// ---------- Generador de apuestas a partir de la convocatoria de la web ----------
function proximoConvocado() {
  if (typeof partidos === "undefined" || typeof convocatoria === "undefined") return null;
  const p = partidos.find(x => x.fecha === convocatoria.partido);
  if (!p) return null;
  const corto = (p.rival.match(/\(([^)]+)\)/) || [])[1] || p.rival;
  const lista = convocatoria.jugadores.map(id => porId[id]).filter(Boolean);
  return { p, corto, lista, pid: `${p.fecha}-${slug(corto)}`, nombre: p.local ? `Laborales FC vs ${corto}` : `${corto} vs Laborales FC`, cierre: new Date(`${p.fecha}T${p.hora || "00:00"}`).toISOString() };
}
function apuestasTipicas(c) {
  const nombres = c.lista.map(j => j.nombre);
  const pos = t => c.lista.filter(j => j.posicion === t).map(j => j.nombre);
  const porteros = pos("Portero"), medios = pos("Centrocampista"), centrales = pos("Defensa central");
  const base = { partidoId: c.pid, partidoNombre: c.nombre, partidoFecha: c.cierre, estado: "abierta", ganadora: null, cierre: c.cierre, creada: new Date().toISOString(), descripcion: "" };
  const L = [];
  const add = (clave, orden, titulo, opciones, extra = {}) => { if (opciones.length >= 2) L.push({ id: `${c.pid}-${clave}`, ...base, orden, titulo, opciones, ...extra }); };
  add("resultado", 1, `¿Quién gana contra ${c.corto}?`, ["Laborales FC", "Empate", c.corto]);
  add("goles", 2, "¿Cuántos goles marca el Laborales?", ["0", "1", "2", "3", "4 o más"]);
  add("primer-gol", 3, "¿Quién marca el primer gol del Laborales?", [...nombres, "Nadie"], { descripcion: "Si no marcamos, gana «Nadie»." });
  add("asistencia", 4, "¿Quién da la primera asistencia?", [...nombres, "Nadie"], { descripcion: "Si no hay ninguna asistencia, gana «Nadie»." });
  if (porteros.length >= 2) add("encajados", 5, "¿Qué portero encaja más goles?", [...porteros, "Ninguno"], { descripcion: "Si encajan los mismos o ninguno encaja, gana «Ninguno»." });
  add("portero-titular", 6, "¿Quién es el portero titular?", porteros);
  add("primer-cambio", 7, "¿Qué suplente entra primero al campo?", nombres, { descripcion: "El primer jugador que sale del banquillo." });
  (EXTRAS[c.p.fecha] || []).forEach(e => add(e.clave, e.orden, e.titulo, e.opciones, { descripcion: e.descripcion || "" }));
  add("regates", 11, "¿Qué centrocampista hace más regates?", medios);
  add("perdidas", 12, "¿Quién pierde más balones?", [...medios, ...centrales], { descripcion: "Centrocampistas y centrales convocados." });
  c.lista.forEach((j, i) => add(`tit-${String(i + 1).padStart(2, "0")}-${j.id}`, 21 + i, j.nombre, ["Titular", "Suplente"], { bloque: "Titulares y suplentes" }));
  return L;
}

// ---------- Pintar ----------
function render() {
  const foco = document.activeElement && document.activeElement.id;
  pintarCartera(); pintarFiltros(); pintarLista(); pintarRanking(); pintarAdmin();
  if (foco && foco.startsWith("lb-") && $(foco) && document.activeElement !== $(foco)) $(foco).focus();
}

function pintarCartera() {
  const c = uid ? cartera(uid) : { beneficio: 0, enJuego: 0, aciertos: 0, jugadas: 0 };
  const pa = partidoActual();
  $("lb-w-saldo").textContent = pa ? fmt(FICHAS - (uid ? gastadoEn(uid, pa.id) : 0)) : "—";
  $("lb-w-partido").textContent = pa ? `Fichas libres para ${pa.nombre}${c.enJuego ? ` · ${fmt(c.enJuego)} en juego` : ""}` : "Ahora mismo no hay apuestas abiertas";
  $("lb-w-beneficio").textContent = conSigno(c.beneficio);
  $("lb-w-aciertos").textContent = `${c.aciertos}/${c.jugadas}`;
  const input = $("lb-apodo");
  if (document.activeElement !== input) input.value = uid ? apodoDe(uid) : "";
  input.disabled = !puedeApostar();
  $("lb-apodo-btn").disabled = !puedeApostar();
}

const FILTROS = [["todas", "Todas"], ["abierta", "En juego"], ["cerrada", "Esperando resultado"], ["resuelta", "Resueltas"]];
const enFiltro = (a, k) => k === "todas" || (k === "resuelta" ? ["resuelta", "anulada"].includes(estadoDe(a)) : estadoDe(a) === k);
function pintarFiltros() {
  $("lb-filtros").innerHTML = FILTROS.map(([k, t]) =>
    `<button data-lb="filtro" data-k="${k}" aria-pressed="${k === filtro}">${t} <small>${apuestas.filter(a => enFiltro(a, k)).length}</small></button>`).join("");
}

function cabEstado(a) {
  const e = estadoDe(a);
  if (e === "abierta") return `<span class="lb-pill lb-abierta">En juego${a.cierre ? ` · cierra ${esc(fechaTxt(a.cierre))}` : ""}</span>`;
  if (e === "cerrada") return `<span class="lb-pill lb-cerrada">Cerrada · esperando resultado</span>`;
  if (e === "anulada") return `<span class="lb-pill lb-gris">Anulada · fichas devueltas</span>`;
  return `<span class="lb-pill lb-gris">Resuelta · gana ${esc(a.opciones[a.ganadora])}</span>`;
}

function pintarLista() {
  const lista = ordenadas().filter(a => enFiltro(a, filtro));
  if (!apuestas.length) {
    $("lb-lista").innerHTML = `<div class="lb-vacio"><strong>${conectado ? "Aún no hay apuestas" : "Cargando apuestas"}</strong>${conectado ? "Aquí irán apareciendo las apuestas de cada partido." : "Las apuestas aparecerán aquí en un momento."}</div>`;
    return;
  }
  if (!lista.length) { $("lb-lista").innerHTML = `<div class="lb-vacio"><strong>Nada por aquí</strong>No hay apuestas en este apartado.</div>`; return; }
  const grupos = [];
  for (const a of lista) { const p = partidoDe(a); let g = grupos.find(x => x.p.id === p.id); if (!g) grupos.push(g = { p, items: [] }); g.items.push(a); }
  $("lb-lista").innerHTML = `<div class="lb-grupos">${grupos.map(g => {
    const abiertas = g.items.some(a => estadoDe(a) === "abierta");
    const quedan = FICHAS - (uid ? gastadoEn(uid, g.p.id) : 0);
    return `<div class="lb-grupo"><div class="lb-grupo-cab">
      <div><span class="etiqueta">${g.p.fecha ? esc(fechaTxt(g.p.fecha)) : "Apuestas"}</span><h3>${esc(g.p.nombre)}</h3></div>
      ${abiertas && puedeApostar() ? `<div class="lb-presupuesto"><strong>${fmt(quedan)}</strong> de ${fmt(FICHAS)} fichas libres</div>` : ""}
    </div><div class="lb-lista">${piezasDe(g).join("")}</div></div>`;
  }).join("")}</div>`;
}

function piezasDe(g) {
  const piezas = [];
  for (const a of g.items) {
    if (!a.bloque) { piezas.push({ a }); continue; }
    let b = piezas.find(x => x.bloque === a.bloque);
    if (!b) piezas.push(b = { bloque: a.bloque, items: [] });
    b.items.push(a);
  }
  return piezas.map(x => {
    if (x.a) return boleto(x.a);
    const clave = g.p.id + "|" + x.bloque;
    const hechas = x.items.filter(miPick).length;
    return `<details class="lb-bloque" data-clave="${esc(clave)}" ${bloquesAbiertos.has(clave) ? "open" : ""}>
      <summary><span>${esc(x.bloque)}</span><small>${x.items.length} apuestas${uid ? ` · has apostado en ${hechas}` : ""}</small></summary>
      <div class="lb-bloque-lista">${x.items.map(boleto).join("")}</div>
    </details>`;
  });
}

function boleto(a) {
  const e = estadoDe(a), { pool, total, gente } = botes(a), mio = miPick(a);
  const nApuestas = gente.reduce((s, g) => s + g.length, 0);
  const seleccionando = sel && sel.a === a.id && e === "abierta";
  const ops = a.opciones.map((o, i) => {
    const pct = total ? Math.round(100 * pool[i] / total) : 0;
    const cuota = pool[i] ? total / pool[i] : null;
    const clases = ["lb-op",
      mio && mio.op === i ? "lb-mia" : "",
      seleccionando && sel.i === i ? "lb-elegida" : "",
      e === "resuelta" && a.ganadora === i ? "lb-ganadora" : "",
      e === "resuelta" && a.ganadora !== i ? "lb-perdedora" : ""].join(" ");
    const accion = resolviendo === a.id ? `data-lb="ganar" data-a="${a.id}" data-i="${i}"` : (e === "abierta" && puedeApostar()) ? `data-lb="elegir" data-a="${a.id}" data-i="${i}"` : "";
    return `<button class="${clases}" ${accion} ${accion ? "" : "disabled"}>
      ${mio && mio.op === i ? `<span class="lb-marca-mia">Tu apuesta</span>` : ""}
      <span class="lb-op-nombre">${esc(o)}</span><span class="lb-cuota" title="Cuota actual">${cuotaTxt(cuota)}</span>
      <span class="lb-op-barra"><i style="width:${pct}%"></i></span>
      <span class="lb-op-meta">${pct}% · ${gente[i].length} ${gente[i].length === 1 ? "apuesta" : "apuestas"}</span>
    </button>`;
  }).join("");

  let resguardo = "";
  if (seleccionando) {
    const disp = disponiblePara(a), s = Math.min(stake, disp);
    resguardo = `<div class="lb-resguardo">
      <p>Vas con <b>${esc(a.opciones[sel.i])}</b>. Puedes poner hasta ${fmt(disp)} fichas de las ${fmt(FICHAS)} de este partido.</p>
      <div class="lb-stake">
        <input id="lb-stake-${a.id}" type="number" inputmode="numeric" min="1" max="${disp}" step="1" value="${s}" data-lb="stake" data-a="${a.id}" aria-label="Fichas a apostar">
        ${[50, 100, 250].filter(v => v < disp).map(v => `<button class="lb-rapido" data-lb="rapido" data-v="${v}">${v}</button>`).join("")}
        <button class="lb-rapido" data-lb="rapido" data-v="${disp}">Todo</button>
      </div>
      <p id="lb-gan-${a.id}">${textoGanancia(a, sel.i, s)}</p>
      <div class="lb-acciones">
        <button class="lb-btn lb-primario" data-lb="apostar" data-a="${a.id}" ${disp < 1 ? "disabled" : ""}>${mio ? "Cambiar apuesta" : "Apostar"}</button>
        <button class="lb-btn" data-lb="cancelar">Cancelar</button>
        ${mio ? `<button class="lb-btn lb-peligro" data-lb="retirar" data-a="${a.id}">Retirar mi apuesta</button>` : ""}
      </div>
    </div>`;
  }

  let miLinea = "";
  if (mio && !seleccionando) {
    const f = fichasDe(mio), nom = esc(a.opciones[mio.op]);
    if (e === "resuelta") {
      const gano = mio.op === a.ganadora;
      miLinea = !pool[a.ganadora] ? `<div class="lb-mi">Nadie acertó: recuperas tus ${fmt(f)} fichas.</div>`
        : gano ? `<div class="lb-mi lb-gano">Acertaste con ${nom}: cobras ${fmt(f * total / pool[a.ganadora])} fichas (+${fmt(f * total / pool[a.ganadora] - f)}).</div>`
        : `<div class="lb-mi lb-perdio">Pusiste ${fmt(f)} fichas a ${nom}. Se fueron.</div>`;
    } else if (e === "anulada") {
      miLinea = `<div class="lb-mi">Apuesta anulada: recuperas tus ${fmt(f)} fichas.</div>`;
    } else {
      miLinea = `<div class="lb-mi">Llevas <b>${fmt(f)}</b> fichas a <b>${nom}</b>. Si aciertas, con las cuotas de ahora cobrarías unas <span class="lb-ganancia">${fmt(f * total / pool[mio.op])}</span>.${e === "abierta" ? " Toca otra opción para cambiarla." : ""}</div>`;
    }
  }

  const quien = nApuestas ? `<details class="lb-quien"><summary>Ver quién ha apostado (${nApuestas})</summary><ul>${a.opciones.map((o, i) => gente[i].length ? `<li><b>${esc(o)}:</b> ${gente[i].sort((x, y) => y.f - x.f).map(g => `<span class="lb-chip">${esc(nombreDe(g.u))} · ${fmt(g.f)}</span>`).join("")}</li>` : "").join("")}</ul></details>` : "";

  let admin = "";
  if (esAdmin) {
    let botones;
    if (borrando === a.id) botones = `<span>¿Borrar esta apuesta para siempre?</span><button class="lb-btn lb-peligro" data-lb="borrar-si" data-a="${a.id}">Sí, borrar</button><button class="lb-btn" data-lb="borrar-no">No</button>`;
    else if (resolviendo === a.id) botones = `<span>Toca la opción ganadora arriba.</span><button class="lb-btn" data-lb="resolver-no">Cancelar</button>`;
    else botones = [
      e === "abierta" ? `<button class="lb-btn" data-lb="cerrar" data-a="${a.id}">Cerrar apuestas</button>` : "",
      e !== "abierta" ? `<button class="lb-btn" data-lb="reabrir" data-a="${a.id}">Reabrir</button>` : "",
      e !== "anulada" ? `<button class="lb-btn lb-primario" data-lb="resolver" data-a="${a.id}">${e === "resuelta" ? "Cambiar ganadora" : "Dar ganadora"}</button>` : "",
      e !== "anulada" ? `<button class="lb-btn" data-lb="anular" data-a="${a.id}">Anular</button>` : "",
      `<button class="lb-btn lb-peligro" data-lb="borrar" data-a="${a.id}">Borrar</button>`].join("");
    admin = `<div class="lb-admin-fila"><span class="etiqueta">Organizador</span>${botones}</div>`;
  }

  return `<article class="tarjeta lb-boleto">
    <div class="lb-b-cab">${cabEstado(a)}<span>Bote ${fmt(total)} fichas · ${nApuestas} ${nApuestas === 1 ? "apuesta" : "apuestas"}</span></div>
    <div class="lb-b-cuerpo">
      <h4>${esc(a.titulo)}</h4>
      ${a.descripcion ? `<p class="lb-desc">${esc(a.descripcion)}</p>` : ""}
      <div class="lb-opciones${a.opciones.length > 6 ? " lb-muchas" : ""}">${ops}</div>
      ${resguardo}${miLinea}${quien}${admin}
    </div>
  </article>`;
}

function textoGanancia(a, op, s) {
  if (!(s >= 1)) return "Pon al menos 1 ficha.";
  const c = cobroPosible(a, op, s);
  return `Si aciertas cobrarías unas <span class="lb-ganancia">${fmt(c)}</span> fichas (+${fmt(c - s)}), según cómo vaya el bote.`;
}

function pintarRanking() {
  const ids = [...new Set([...Object.keys(votos).filter(u => apodoDe(u) || Object.keys((votos[u] && votos[u].picks) || {}).length), ...(uid ? [uid] : [])])];
  if (!ids.length) { $("lb-ranking").innerHTML = `<li class="lb-nadie">Todavía no ha apostado nadie.</li>`; return; }
  const filas = ids.map(u => ({ u, ...cartera(u) })).sort((x, y) => y.beneficio - x.beneficio || y.aciertos - x.aciertos);
  $("lb-ranking").innerHTML = filas.map((f, i) => `<li class="${f.u === uid ? "lb-yo" : ""}">
    <span class="lb-pos">${i + 1}</span>
    <span class="lb-quien-r"><b>${esc(f.u === uid && !apodoDe(uid) ? "Tú (sin apodo)" : nombreDe(f.u))}${i === 0 && filas.length > 1 ? `<span class="lb-tag lb-lider">Líder</span>` : ""}${i === filas.length - 1 && filas.length >= 3 ? `<span class="lb-tag lb-farolillo">Farolillo rojo</span>` : ""}${f.u === uid ? `<span class="lb-tag lb-tu">Tú</span>` : ""}</b>
      <small>${f.aciertos}/${f.jugadas} aciertos${f.enJuego ? ` · ${fmt(f.enJuego)} en juego` : ""}</small></span>
    <span class="lb-saldo">${conSigno(f.beneficio)}<small>fichas</small></span>
  </li>`).join("");
}

function pintarAdmin() {
  $("lb-admin").hidden = !esAdmin;
  $("lb-acceso").textContent = esAnonimo ? "Acceso organizador" : "Salir del modo organizador";
  if (!esAdmin) return;
  const c = proximoConvocado();
  if (!c) { $("lb-gen-texto").textContent = "No hay convocatoria publicada en la web."; $("lb-gen").disabled = true; }
  else {
    const nuevas = apuestasTipicas(c).filter(x => !apuestas.some(a => a.id === x.id));
    $("lb-gen-texto").textContent = nuevas.length
      ? `${c.nombre}: se crearán ${nuevas.length} apuestas con los ${c.lista.length} convocados de la web.`
      : `${c.nombre}: las apuestas de este partido ya están creadas.`;
    $("lb-gen").disabled = !nuevas.length;
  }
  $("lb-lista-partidos").innerHTML = [...new Set(apuestas.map(a => partidoDe(a).nombre))].map(n => `<option value="${esc(n)}"></option>`).join("");
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
    const nuevo = cambio({ apodo: actual.apodo || "", picks: actual.picks || {} });
    await setDoc(doc(db, "votos", uid), nuevo);
    if (ok) toast(ok);
  }).catch(fallo);
  return cola;
}
async function cambiarApuesta(id, datos, ok) {
  try { await updateDoc(doc(db, "apuestas", id), datos); if (ok) toast(ok); } catch (e) { fallo(e); }
}

// ---------- Eventos ----------
function enlazarEventos() {
  $("lb").addEventListener("click", ev => {
    const b = ev.target.closest("[data-lb]");
    if (!b || b.tagName === "INPUT") return;
    const acc = b.dataset.lb, a = apuestas.find(x => x.id === b.dataset.a);
    switch (acc) {
      case "filtro": filtro = b.dataset.k; render(); break;
      case "elegir": {
        if (!apodoDe(uid)) { toast("Antes de apostar, ponte un apodo arriba."); $("lb-apodo").focus(); break; }
        const mio = miPick(a);
        sel = { a: a.id, i: +b.dataset.i };
        stake = mio ? fichasDe(mio) : Math.min(100, disponiblePara(a)) || 0;
        render(); break;
      }
      case "rapido": stake = +b.dataset.v; render(); break;
      case "cancelar": sel = null; render(); break;
      case "apostar": {
        if (!a || estadoDe(a) !== "abierta") { toast("Esta apuesta ya está cerrada."); sel = null; render(); break; }
        const s = Math.floor(Math.min(stake, disponiblePara(a)));
        if (!(s >= 1)) { toast("Pon al menos 1 ficha."); break; }
        const op = sel.i; sel = null;
        guardarMio(d => { d.picks[a.id] = { op, fichas: s, t: new Date().toISOString() }; return d; }, `Apostadas ${fmt(s)} fichas a ${a.opciones[op]}`);
        break;
      }
      case "retirar": sel = null; guardarMio(d => { delete d.picks[a.id]; return d; }, "Apuesta retirada"); break;
      case "cerrar": cambiarApuesta(a.id, { estado: "cerrada" }, "Apuestas cerradas"); break;
      case "reabrir": cambiarApuesta(a.id, { estado: "abierta", ganadora: null, cierre: null }, "Apuesta reabierta"); break;
      case "resolver": resolviendo = a.id; sel = null; render(); break;
      case "resolver-no": resolviendo = null; render(); break;
      case "ganar": resolviendo = null; cambiarApuesta(a.id, { estado: "resuelta", ganadora: +b.dataset.i, resuelta: new Date().toISOString() }, `Gana ${a.opciones[+b.dataset.i]}`); break;
      case "anular": cambiarApuesta(a.id, { estado: "anulada", ganadora: null }, "Apuesta anulada, fichas devueltas"); break;
      case "borrar": borrando = a.id; render(); break;
      case "borrar-no": borrando = null; render(); break;
      case "borrar-si": borrando = null; deleteDoc(doc(db, "apuestas", a.id)).then(() => toast("Apuesta borrada"), fallo); break;
    }
  });
  $("lb").addEventListener("input", ev => {
    const el = ev.target;
    if (el.dataset && el.dataset.lb === "stake") {
      const a = apuestas.find(x => x.id === el.dataset.a);
      stake = Math.floor(Number(el.value)) || 0;
      if (a && sel) $("lb-gan-" + a.id).innerHTML = textoGanancia(a, sel.i, Math.min(stake, disponiblePara(a)));
    }
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
    const c = proximoConvocado(); if (!c) return;
    const nuevas = apuestasTipicas(c).filter(x => !apuestas.some(a => a.id === x.id));
    if (!nuevas.length) return;
    const lote = writeBatch(db);
    nuevas.forEach(({ id, ...datos }) => lote.set(doc(db, "apuestas", id), datos));
    try { await lote.commit(); toast(`${nuevas.length} apuestas creadas`); } catch (e) { fallo(e); }
  });
  $("lb-form-crear").addEventListener("submit", async ev => {
    ev.preventDefault();
    const titulo = $("lb-c-titulo").value.trim();
    const opciones = [...new Set($("lb-c-opciones").value.split("\n").map(s => s.trim()).filter(Boolean))].slice(0, 30);
    if (!titulo || opciones.length < 2) { toast("Hace falta una pregunta y al menos 2 opciones."); return; }
    const c = $("lb-c-cierre").value, partidoNombre = $("lb-c-partido").value.trim();
    const existente = apuestas.map(partidoDe).find(p => p.nombre.toLowerCase() === partidoNombre.toLowerCase());
    const cierre = c ? new Date(c).toISOString() : null;
    try {
      await addDoc(collection(db, "apuestas"), { titulo, descripcion: $("lb-c-desc").value.trim(), opciones, estado: "abierta", ganadora: null, cierre, creada: new Date().toISOString(),
        partidoId: existente ? existente.id : (slug(partidoNombre) || "general"), partidoNombre: existente ? existente.nombre : partidoNombre, partidoFecha: existente ? existente.fecha : cierre });
      $("lb-c-titulo").value = ""; $("lb-c-desc").value = ""; $("lb-c-opciones").value = ""; toast("Apuesta publicada");
    } catch (e) { fallo(e); }
  });
}

// ---------- Arranque ----------
function arrancar() {
  enlazarEventos();
  configurado = !!(firebaseConfig && firebaseConfig.apiKey && !String(firebaseConfig.apiKey).startsWith("PEGA"));
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
    apuestas = s.docs.map(d => ({ id: d.id, ...d.data() })).filter(a => typeof a.titulo === "string" && Array.isArray(a.opciones) && a.opciones.length >= 2);
    listo(); render();
  }, error);
  onSnapshot(collection(db, "votos"), s => {
    votos = {}; s.docs.forEach(d => { votos[d.id] = d.data(); });
    listo(); render();
  }, error);
  // Las apuestas con hora de cierre se cierran solas al llegar la hora
  setInterval(() => { if (apuestas.some(a => a.cierre && a.estado === "abierta")) render(); }, 30000);
}
arrancar();
