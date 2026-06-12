// Edge Function: auto-sync
// Sincroniza en el servidor (sin la PC del usuario):
//   - Lee el Google Sheet público de cada Fuente → ventas → registros + crm_ventas
//   - (Opcional) llama a Meta API por Fuente → gasto/impresiones/clics/chats
//   - Actualiza el estado de consolidación de los días afectados
//
// Pensada para correr por cron. Protegida por un secreto compartido.
// Body opcional: { user_id?: string, days?: number, meta?: boolean }

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("ADMIN_SERVICE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const AUTOSYNC_SECRET = Deno.env.get("AUTOSYNC_SECRET") ?? "";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-autosync-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

// ── REST helper con service role ──
async function sb(method: string, path: string, body?: unknown, prefer?: string) {
  const headers: Record<string, string> = {
    apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json",
  };
  if (prefer) headers["Prefer"] = prefer;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  const txt = await res.text();
  return txt ? JSON.parse(txt) : null;
}

// ── Parser CSV (portado del cliente) ──
function parseSheetCSV(text: string) {
  const lines = text.trim().split("\n").filter((l) => l.trim());
  if (lines.length < 2) return [];
  const parseLine = (line: string) => {
    const cols: string[] = []; let cur = "", inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { if (inQ && line[i + 1] === '"') { cur += '"'; i++; } else inQ = !inQ; }
      else if (ch === "," && !inQ) { cols.push(cur.trim()); cur = ""; }
      else if (ch !== "\r") cur += ch;
    }
    cols.push(cur.trim());
    return cols;
  };
  const headers = parseLine(lines[0]).map((h) => h.replace(/"/g, "").toLowerCase().trim());
  const findH = (opts: string[]) => { for (const o of opts) { const i = headers.indexOf(o); if (i >= 0) return i; } return -1; };
  const iAdId = findH(["ad id", "ad_id", "adid"]);
  const iFecha = findH(["fecha y hora", "fecha", "timestamp"]);
  const iValor = findH(["valor", "value", "precio", "monto"]);
  const iTel = findH(["numero de celular", "telefono", "phone", "celular"]);
  const iProd = findH(["producto", "product"]);
  const iUp = [findH(["upsell 1", "upsell1"]), findH(["upsell 2", "upsell2"]), findH(["upsell 3", "upsell3"]), findH(["upsell 4", "upsell4"])];
  if (iAdId < 0 || iFecha < 0) return [];
  const parseVal = (raw: string) => parseFloat((raw || "").toString().replace(/S\/\s*/i, "").replace(/[^0-9.]/g, "")) || 0;
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseLine(lines[i]);
    const adId = (cols[iAdId] || "").replace(/"/g, "").trim().replace(/\.0$/, "");
    if (!adId) continue;
    const horaRaw = (cols[iFecha] || "").replace(/"/g, "").trim();
    if (!horaRaw || !horaRaw.includes("T")) continue;
    const fecha = horaRaw.split("T")[0];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) continue;
    const valor = parseVal(cols[iValor] || "");
    if (valor <= 0) continue;
    rows.push({
      adId, fecha, hora: horaRaw, valor,
      telefono: iTel >= 0 ? (cols[iTel] || "").replace(/"/g, "").trim() : "",
      producto: iProd >= 0 ? (cols[iProd] || "").replace(/"/g, "").trim() : "",
      up1: iUp[0] >= 0 ? parseVal(cols[iUp[0]]) : 0, up2: iUp[1] >= 0 ? parseVal(cols[iUp[1]]) : 0,
      up3: iUp[2] >= 0 ? parseVal(cols[iUp[2]]) : 0, up4: iUp[3] >= 0 ? parseVal(cols[iUp[3]]) : 0,
    });
  }
  return rows;
}

const limpiar = (s: string) => (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
function similitud(a: string, b: string) {
  const wa = limpiar(a).split(" ").filter((w) => w.length > 2);
  const wb = new Set(limpiar(b).split(" ").filter((w) => w.length > 2));
  if (!wa.length || !wb.size) return 0;
  return wa.filter((w) => wb.has(w)).length / wa.length;
}
function normalizarProducto(nombre: string, wsNames: string[]) {
  if (!nombre) return "";
  if (!wsNames?.length) return nombre;
  let mejor = nombre, score = 0.55;
  for (const n of wsNames) { const s = similitud(nombre, n); if (s > score) { score = s; mejor = n; } }
  return mejor;
}

const nDaysAgo = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };
const enc = encodeURIComponent;

// ── Sincroniza un Sheet (una fuente) ──
async function syncSheet(job: { url: string; wsList: any[]; userId: string }) {
  const sheetId = (job.url.match(/\/d\/([a-zA-Z0-9_-]+)/) || [])[1] || job.url;
  const res = await fetch(`https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv`);
  if (!res.ok) throw new Error(`Sheet ${job.url} no accesible (${res.status})`);
  const allRows = parseSheetCSV(await res.text());
  const fechaMin = nDaysAgo(90);
  const recientes = allRows.filter((r) => r.fecha >= fechaMin);
  if (!recientes.length) return { ventas: 0, registros: 0, wsIds: [] as string[] };

  const wsNames = job.wsList.map((w) => w.nombre || "");
  const wsNombreToId: Record<string, string> = {};
  const adIdToWs: Record<string, string> = {};
  const wsCfg: Record<string, any> = {};
  for (const ws of job.wsList) {
    wsNombreToId[ws.nombre || ""] = ws.id;
    const ads = await sb("GET", `anuncios?workspace_id=eq.${ws.id}&select=ad_id`);
    (ads || []).forEach((a: any) => { adIdToWs[a.ad_id] = ws.id; });
    const cfg = await sb("GET", `config?workspace_id=eq.${ws.id}&select=p1,p2,p3,p4&limit=1`);
    wsCfg[ws.id] = (cfg && cfg[0]) || { p1: 10, p2: 7, p3: 5, p4: 3 };
  }
  const allAdIds = new Set(Object.keys(adIdToWs));
  const rows = allAdIds.size ? recientes.filter((r) => allAdIds.has(r.adId)) : recientes;
  if (!rows.length) return { ventas: 0, registros: 0, wsIds: [] };

  // Dedup ventana 10s
  const seen = new Set<string>(); const unicas = [];
  for (const r of rows) { const k = `${r.adId}|${r.telefono}|${r.hora.substring(0, 18)}`; if (seen.has(k)) continue; seen.add(k); unicas.push(r); }

  const grupos: Record<string, any> = {}; const crmRows = [];
  for (const r of unicas) {
    const prodNorm = normalizarProducto(r.producto || "", wsNames);
    const wsId = wsNombreToId[prodNorm] || adIdToWs[r.adId] || job.wsList[0]?.id;
    if (!wsId) continue;
    const P = wsCfg[wsId] || { p1: 10, p2: 7, p3: 5, p4: 3 };
    const key = `${r.fecha}||${r.adId}||${prodNorm}`;
    if (!grupos[key]) grupos[key] = { fecha: r.fecha, adId: r.adId, v1: 0, v2: 0, v3: 0, v4: 0, upsell: 0, wsId };
    const g = grupos[key];
    const activos: [number, number][] = [[+P.p1, 0], [+P.p2, 1], [+P.p3, 2], [+P.p4, 3]].filter(([p]) => p > 0);
    const exacto = activos.find(([p]) => Math.abs(r.valor - p) < 0.5);
    const idx = exacto ? exacto[1] : activos.reduce((bi, [p, i]) => Math.abs(r.valor - p) < Math.abs(r.valor - activos[bi][0]) ? i : bi, 0);
    if (idx === 0) g.v1++; else if (idx === 1) g.v2++; else if (idx === 2) g.v3++; else g.v4++;
    g.upsell += r.up1 + r.up2 + r.up3 + r.up4;
    if (r.hora && r.valor > 0) crmRows.push({ fecha: r.fecha, ad_id: r.adId, hora: r.hora, precio: r.valor, workspace_id: wsId, user_id: job.userId });
  }

  // Consolidar por wsId+adId+fecha
  const regMap: Record<string, any> = {};
  for (const g of Object.values(grupos) as any[]) {
    const k = `${g.wsId}||${g.adId}||${g.fecha}`;
    if (!regMap[k]) regMap[k] = { ...g };
    else { regMap[k].v1 += g.v1; regMap[k].v2 += g.v2; regMap[k].v3 += g.v3; regMap[k].v4 += g.v4; regMap[k].upsell += g.upsell; }
  }
  const registros = Object.values(regMap) as any[];

  // Blindaje: no pisar ventas corregidas a mano
  const protegidos = new Set<string>();
  for (const ws of job.wsList) {
    const prot = await sb("GET", `registros?workspace_id=eq.${ws.id}&corregido_manual=eq.true&fecha=gte.${fechaMin}&select=ad_id,fecha`);
    (prot || []).forEach((p: any) => protegidos.add(`${ws.id}||${p.ad_id}||${p.fecha}`));
  }

  // Upsert registros (crear vacío + patch ventas)
  for (let i = 0; i < registros.length; i += 50) {
    const lote = registros.slice(i, i + 50);
    await sb("POST", "registros?on_conflict=workspace_id,ad_id,fecha", lote.map((r) => ({
      fecha: r.fecha, ad_id: r.adId, v1: 0, v2: 0, v3: 0, v4: 0, upsell_total: 0,
      gasto_meta: 0, impr_meta: 0, clics_meta: 0, chats_meta: 0,
      gasto_tiktok: 0, impr_tiktok: 0, clics_tiktok: 0, chats_tiktok: 0,
      workspace_id: r.wsId, user_id: job.userId,
    })), "resolution=ignore-duplicates,return=minimal").catch(() => {});
    for (const r of lote) {
      if (protegidos.has(`${r.wsId}||${r.adId}||${r.fecha}`)) continue;
      await sb("PATCH", `registros?workspace_id=eq.${r.wsId}&fecha=eq.${r.fecha}&ad_id=eq.${enc(r.adId)}`,
        { v1: r.v1, v2: r.v2, v3: r.v3, v4: r.v4, upsell_total: r.upsell }, "return=minimal").catch(() => {});
    }
  }

  // crm_ventas: reescribir por workspace
  if (crmRows.length) {
    const wsIds = [...new Set(crmRows.map((r) => r.workspace_id))];
    for (const wsId of wsIds) {
      await sb("DELETE", `crm_ventas?workspace_id=eq.${wsId}&fecha=gte.${fechaMin}`).catch(() => {});
    }
    const cseen = new Set<string>();
    const uniq = crmRows.filter((r) => { const k = `${r.ad_id}|${r.hora}|${r.precio}`; if (cseen.has(k)) return false; cseen.add(k); return true; });
    for (let i = 0; i < uniq.length; i += 100) {
      await sb("POST", "crm_ventas", uniq.slice(i, i + 100), "return=minimal").catch(() => {});
    }
  }

  return { ventas: unicas.length, registros: registros.length, wsIds: [...new Set(registros.map((r) => r.wsId))] };
}

// ── Meta gasto por fuente ──
async function syncMeta(fuente: any, wsList: any[]) {
  const cuentas = Array.isArray(fuente.meta_cuentas) ? fuente.meta_cuentas : [];
  if (!fuente.meta_token || !cuentas.length) return { filas: 0 };
  const desde = nDaysAgo(3), hasta = nDaysAgo(0);
  const adIdToWs: Record<string, string> = {};
  for (const ws of wsList) {
    const ads = await sb("GET", `anuncios?workspace_id=eq.${ws.id}&select=ad_id`);
    (ads || []).forEach((a: any) => { adIdToWs[a.ad_id] = ws.id; });
  }
  const fields = "ad_id,ad_name,spend,impressions,inline_link_clicks,actions,date_start";
  let aplicadas = 0;
  for (const c of cuentas) {
    const cid = c.id || c;
    let url: string | null = `https://graph.facebook.com/v19.0/${cid}/insights?fields=${fields}&time_range={"since":"${desde}","until":"${hasta}"}&time_increment=1&level=ad&limit=500&access_token=${fuente.meta_token}`;
    while (url) {
      const r = await fetch(url); const jd = await r.json();
      if (jd.error) break;
      for (const row of (jd.data || [])) {
        const wsId = adIdToWs[row.ad_id]; if (!wsId) continue;
        const acts = row.actions || [];
        const msg = acts.find((a: any) => ["onsite_conversion.messaging_conversation_started_7d", "onsite_conversion.messaging_first_reply", "onsite_conversion.total_messaging_connection"].includes(a.action_type));
        await sb("POST", "registros?on_conflict=workspace_id,ad_id,fecha", [{
          workspace_id: wsId, user_id: fuente.user_id, ad_id: row.ad_id, fecha: row.date_start,
          gasto_meta: 0, impr_meta: 0, clics_meta: 0, chats_meta: 0, v1: 0, v2: 0, v3: 0, v4: 0, upsell_total: 0,
        }], "resolution=ignore-duplicates,return=minimal").catch(() => {});
        await sb("PATCH", `registros?workspace_id=eq.${wsId}&ad_id=eq.${enc(row.ad_id)}&fecha=eq.${row.date_start}`, {
          gasto_meta: parseFloat(row.spend) || 0, impr_meta: parseInt(row.impressions) || 0,
          clics_meta: parseInt(row.inline_link_clicks) || 0, chats_meta: msg ? parseInt(msg.value) || 0 : 0,
        }, "return=minimal").catch(() => {});
        aplicadas++;
      }
      url = jd.paging?.next || null;
    }
  }
  return { filas: aplicadas };
}

// ── Consolidación (portada) ──
async function consolidar(wsId: string, ws: any) {
  const desde = nDaysAgo(6); const ahora = new Date(); const iso = ahora.toISOString();
  const rate = (ws.currency_code === "USD") ? 1 : (+ws.usd_rate || 3.7);
  const regs = await sb("GET", `registros?workspace_id=eq.${wsId}&fecha=gte.${desde}&select=fecha,gasto_meta,gasto_tiktok`);
  const estados = await sb("GET", `dia_estado?workspace_id=eq.${wsId}&fecha=gte.${desde}`);
  const porFecha: Record<string, number> = {};
  (regs || []).forEach((r: any) => { porFecha[r.fecha] = (porFecha[r.fecha] || 0) + (+r.gasto_meta || 0) + (+r.gasto_tiktok || 0); });
  const estMap: Record<string, any> = {}; (estados || []).forEach((e: any) => { estMap[e.fecha] = e; });
  for (const [fecha, gRaw] of Object.entries(porFecha)) {
    const g = +(+gRaw).toFixed(2); const e = estMap[fecha];
    if (!e) {
      await sb("POST", "dia_estado", [{ workspace_id: wsId, user_id: ws.user_id, fecha, gasto_total: g, gasto_anterior: g, gasto_provisional: g, primer_sync_at: iso, ultimo_cambio_at: iso, consolidado: false, usd_rate: rate }], "return=minimal").catch(() => {});
      continue;
    }
    if (e.consolidado) continue;
    const cambio = Math.abs(g - (+e.gasto_total || 0)) > 0.001;
    const primer = new Date(e.primer_sync_at || e.created_at || ahora);
    const ult = new Date(e.ultimo_cambio_at || primer);
    const hC = (+ahora - +ult) / 36e5, hP = (+ahora - +primer) / 36e5;
    const patch: any = {};
    if (cambio) { patch.gasto_anterior = e.gasto_total; patch.gasto_total = g; patch.ultimo_cambio_at = iso; }
    if ((!cambio && hC >= 24) || hP >= 48) { patch.consolidado = true; patch.consolidado_at = iso; patch.usd_rate = rate; patch.gasto_total = g; }
    if (Object.keys(patch).length) await sb("PATCH", `dia_estado?id=eq.${e.id}`, patch, "return=minimal").catch(() => {});
  }
}

// Procesa todas las fuentes de un usuario (ventas + opcional Meta + consolidación)
async function procesarUsuario(userId: string, conMeta: boolean) {
  const fuentes = await sb("GET", `fuentes?user_id=eq.${userId}`);
  const workspaces = await sb("GET", `workspaces?user_id=eq.${userId}`);
  const wsTouched = new Set<string>();
  let totVentas = 0;
  for (const f of (fuentes || [])) {
    const wsList = (workspaces || []).filter((w: any) => w.fuente_id === f.id);
    const wsForJob = wsList.length ? wsList : workspaces;
    if (f.sheets_url) {
      try {
        const r = await syncSheet({ url: f.sheets_url, wsList: wsForJob, userId });
        totVentas += r.ventas; r.wsIds.forEach((id) => wsTouched.add(id));
      } catch (e) { console.error("syncSheet", f.nombre, e); }
    }
    if (conMeta) {
      try { await syncMeta(f, wsForJob); (wsForJob || []).forEach((w: any) => wsTouched.add(w.id)); }
      catch (e) { console.error("syncMeta", f.nombre, e); }
    }
  }
  for (const wsId of wsTouched) {
    const ws = (workspaces || []).find((w: any) => w.id === wsId);
    if (ws) await consolidar(wsId, ws).catch((e) => console.error("consolidar", e));
  }
  return { userId, ventas: totVentas, workspaces: wsTouched.size };
}

// Modo programado: lee sync_config de cada usuario y dispara según sus horas (Perú UTC-5)
async function runScheduled() {
  const peru = new Date(Date.now() - 5 * 3600 * 1000);
  const nowMin = peru.getUTCHours() * 60 + peru.getUTCMinutes();
  const hoy = peru.toISOString().slice(0, 10);
  const toMin = (hhmm: string) => { const [h, m] = (hhmm || "").split(":").map(Number); return (h || 0) * 60 + (m || 0); };
  const cfgs = await sb("GET", "sync_config?activo=eq.true").catch(() => []);
  const ejecutados: any[] = [];
  for (const cfg of (cfgs || [])) {
    // Noche (con Meta) tiene prioridad; luego mañana (solo ventas)
    if (nowMin >= toMin(cfg.hora_noche || "23:00") && cfg.ultima_noche !== hoy) {
      const r = await procesarUsuario(cfg.user_id, true);
      await sb("PATCH", `sync_config?user_id=eq.${cfg.user_id}`, { ultima_noche: hoy }, "return=minimal").catch(() => {});
      ejecutados.push({ ...r, slot: "noche" });
    } else if (nowMin >= toMin(cfg.hora_manana || "06:30") && cfg.ultima_manana !== hoy) {
      const r = await procesarUsuario(cfg.user_id, false);
      await sb("PATCH", `sync_config?user_id=eq.${cfg.user_id}`, { ultima_manana: hoy }, "return=minimal").catch(() => {});
      ejecutados.push({ ...r, slot: "manana" });
    }
  }
  return json({ ok: true, scheduled: true, hora_peru: `${String(peru.getUTCHours()).padStart(2, "0")}:${String(peru.getUTCMinutes()).padStart(2, "0")}`, ejecutados });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);

  // Auth por secreto compartido (cron) o service role en Authorization
  const secret = req.headers.get("x-autosync-secret") || "";
  const authz = (req.headers.get("Authorization") || "").replace("Bearer ", "");
  if (AUTOSYNC_SECRET && secret !== AUTOSYNC_SECRET && authz !== SERVICE_KEY)
    return json({ error: "No autorizado" }, 401);

  try {
    const body = await req.json().catch(() => ({}));

    // Modo programado (lo invoca el cron cada 15 min)
    if (body.scheduled) return await runScheduled();

    // Modo manual / directo
    const conMeta = body.meta !== false;
    let userIds: string[];
    if (body.user_id) userIds = [body.user_id];
    else {
      const fs = await sb("GET", "fuentes?select=user_id");
      userIds = [...new Set((fs || []).map((f: any) => f.user_id))];
    }
    const resumen: any[] = [];
    for (const userId of userIds) resumen.push(await procesarUsuario(userId, conMeta));
    return json({ ok: true, procesados: resumen.length, resumen });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
