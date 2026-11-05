// Função serverless da Vercel: busca na planilha do Google e devolve só o produto pedido.
// Uso: /api/ficha?codigo=52363   |   /api/ficha?q=leave   (lista de busca)

const SHEET_ID = "13nvhq4YBJxP_GvhtHI5ZANQpRxKYC_eTSxGDNWZ8cfE";
const ABAS = { envase: "BD_ENVASE", espec: "BD_ESPEC", codigos: "CÓDIGOS" };

const N = s => String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/\s+/g, " ").trim();
const D = s => String(s ?? "").replace(/\D/g, "");
const vazio = v => v === undefined || v === null || ["", "-", "0"].includes(String(v).trim());
const g = (o, p) => { const k = Object.keys(o).find(k => k.startsWith(p)); return k ? o[k] : ""; };

function csv(t) {
  const r = []; let a = [], c = "", q = false;
  for (let i = 0; i < t.length; i++) {
    const x = t[i];
    if (q) { if (x == '"') { if (t[i + 1] == '"') { c += '"'; i++; } else q = false; } else c += x; }
    else if (x == '"') q = true;
    else if (x == ",") { a.push(c); c = ""; }
    else if (x == "\n" || x == "\r") { if (x == "\r" && t[i + 1] == "\n") i++; a.push(c); r.push(a); a = []; c = ""; }
    else c += x;
  }
  if (c || a.length) { a.push(c); r.push(a); }
  return r;
}

function tabela(rows, chave) {
  const i = rows.findIndex(r => r.some(c => N(c) == chave));
  if (i < 0) return [];
  const h = rows[i].map(N);
  return rows.slice(i + 1).map(r => {
    const o = {};
    h.forEach((k, j) => { if (k && !(k in o)) o[k] = String(r[j] ?? "").trim(); });
    return o;
  }).filter(o => Object.values(o).some(Boolean));
}

async function aba(nome) {
  const u = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(nome)}`;
  const r = await fetch(u);
  if (!r.ok) throw new Error(`Aba ${nome}: o Google respondeu ${r.status}. A planilha precisa estar compartilhada como "qualquer pessoa com o link".`);
  return csv(await r.text());
}

let cache = { t: 0, db: null };
async function carregar() {
  if (cache.db && Date.now() - cache.t < 300000) return cache.db;
  const [e, s, c] = await Promise.all([aba(ABAS.envase), aba(ABAS.espec), aba(ABAS.codigos)]);
  const db = { envase: tabela(e, "CODIGOS"), espec: tabela(s, "LINHA&PRODUTO"), codigos: tabela(c, "CODIGO") };
  if (!db.envase.length) throw new Error("Não encontrei a aba BD_ENVASE com a coluna CÓDIGOS.");
  cache = { t: Date.now(), db };
  return db;
}

function faixa(min, max) {
  const a = vazio(min) ? "" : min, b = vazio(max) ? "" : max;
  if (!a && !b) return "";
  if (N(b) == "MIN") return "Mín. " + a;
  if (!b) return a;
  if (!a) return "Máx. " + b;
  return a + " a " + b;
}

function montar(db, cod) {
  const e = db.envase.find(o => D(o["CODIGOS"]) == cod && /^\d+$/.test(String(o["CODIGOS"]).trim()));
  if (!e) return null;
  const chave = N(e["LINHA"]) + "|" + N(e["PRODUTO"]);
  const s = db.espec.find(o => N(o["LINHA"]) + "|" + N(o["PRODUTO"]) == chave) || {};
  const itens = new Map();
  db.codigos.forEach(o => { const k = D(o["CODIGO"]); if (k && !itens.has(k)) itens.set(k, o); });

  const v = faixa(g(s, "VISCOSIDADE MIN"), g(s, "VISCOSIDADE MAX")), obs = s["OBSERVACAO"];
  const partes = [["Frasco", "FRASCO"], ["Tampa", "TAMPA"], ["Rótulo / Sleeve", "ROTULO SLEEVE"], ["Cot Rótulo", "COT ROTULO"], ["Frasco (PI)", "FRASCO (PI)"]];
  const envase = partes.filter(([, k]) => !vazio(e[k])).map(([nome, k]) => {
    const c = D(e[k]), i = itens.get(c);
    return { cod: c, desc: nome + (i && i["DESCRICAO"] ? " – " + i["DESCRICAO"] : "") };
  });
  const cx = D(e["COD CAIXA"]), ci = itens.get(cx) || {};
  const tot = !vazio(ci["QDE. POR PALETE"]) ? ci["QDE. POR PALETE"]
    : (ci["LASTRO"] && ci["CAMADAS"] ? String(Number(ci["LASTRO"]) * Number(ci["CAMADAS"])) : "");
  return {
    cod, prod: e["DESCRICAO"], anvisa: g(s, "N° PROCESSO"),
    aspecto: s["ASPECTO"], cor: s["COR"], odor: s["ODOR"],
    ph: faixa(g(s, "PH MIN"), g(s, "PH MAX")),
    visc: v && obs ? `${v} (${obs})` : v,
    dens: faixa(g(s, "DENSIDADE MIN"), g(s, "DENSIDADE MAX")),
    envase, qcx: e["QDE P CAIXA"], cxcod: cx, cxdesc: ci["DESCRICAO"],
    alt: ci["ALTURA"], larg: ci["LARGURA"], comp: ci["COMPRIMENTO"],
    last: ci["LASTRO"], cam: ci["CAMADAS"], tot,
    semEspec: !Object.keys(s).length
  };
}

module.exports = async (req, res) => {
  try {
    const db = await carregar();
    const { codigo, q } = req.query || {};
    if (codigo !== undefined) {
      const f = montar(db, D(codigo));
      if (!f) return res.status(404).json({ erro: `Produto ${D(codigo) || codigo} não encontrado na aba BD_ENVASE.` });
      res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
      return res.status(200).json(f);
    }
    const t = N(q || "").split(" ").filter(Boolean);
    const lista = db.envase
      .filter(o => /^\d{5}$/.test(String(o["CODIGOS"]).trim()) && t.every(w => N(o["DESCRICAO"] + " " + o["CODIGOS"]).includes(w)))
      .slice(0, 40).map(o => ({ cod: o["CODIGOS"], desc: o["DESCRICAO"] }));
    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
    return res.status(200).json(lista);
  } catch (e) {
    return res.status(500).json({ erro: e.message });
  }
};
