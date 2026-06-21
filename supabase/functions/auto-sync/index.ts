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
// Marcador de versión: aparece en cada respuesta JSON. Si no aparece, el deploy es viejo.
const FN_VERSION = "2026-06-21-autosync-intervalo";

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

// GET paginado (PostgREST corta en ~1000 filas por request).
async function sbAll(pathBase: string): Promise<any[]> {
  let out: any[] = [], offset = 0;
  while (true) {
    const sep = pathBase.includes("?") ? "&" : "?";
    const page = await sb("GET", `${pathBase}${sep}limit=1000&offset=${offset}`).catch(() => []);
    out.push(...(page || []));
    if (!page || page.length < 1000) break;
    offset += 1000;
    if (offset > 100000) break;
  }
  return out;
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
  // Buscar la FILA de encabezado en las primeras filas (gviz puede devolver "Column 1".. o
  // haber una fila en blanco/título arriba → el encabezado real no siempre es la fila 0).
  const findHIn = (hdrs: string[], opts: string[]) => {
    for (const o of opts) { const i = hdrs.indexOf(o); if (i >= 0) return i; }
    for (const o of opts) { for (let k=0;k<hdrs.length;k++){ if (hdrs[k] && hdrs[k].indexOf(o)>=0) return k; } }
    return -1;
  };
  let headerIdx = -1; let headers: string[] | null = null;
  for (let li = 0; li < Math.min(lines.length, 8); li++) {
    const cand = parseLine(lines[li]).map((h) => h.replace(/"/g, "").toLowerCase().trim());
    if (findHIn(cand, ["ad id","ad_id","adid"]) >= 0 && findHIn(cand, ["fecha y hora","fecha","timestamp"]) >= 0) { headerIdx = li; headers = cand; break; }
  }
  if (!headers) return [];
  const findH = (opts: string[]) => findHIn(headers as string[], opts);
  const iAdId = findH(["ad id", "ad_id", "adid"]);
  const iFecha = findH(["fecha y hora", "fecha", "timestamp"]);
  const iValor = findH(["valor", "value", "precio", "monto"]);
  const iTel = findH(["numero de celular", "telefono", "phone", "celular"]);
  const iProd = findH(["producto", "product"]);
  const iCli = findH(["nombre del cliente", "nombre cliente", "id cliente", "cliente", "nombre", "customer name", "customer", "id"]);
  const iUp = [findH(["upsell 1", "upsell1"]), findH(["upsell 2", "upsell2"]), findH(["upsell 3", "upsell3"]), findH(["upsell 4", "upsell4"])];
  const iUid = findH(["_uid", "uid"]);   // ID estable que escribe el Apps Script (puede no existir aún)
  const parseVal = (raw: string) => parseFloat((raw || "").toString().replace(/S\/\s*/i, "").replace(/[^0-9.]/g, "")) || 0;
  const rows = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const cols = parseLine(lines[i]);
    let adId = (cols[iAdId] || "").replace(/"/g, "").trim().replace(/\.0$/, "");
    if (!adId) adId = "SIN_ID";   // sin Ad ID: igual cuenta como venta (se asigna por producto)
    const horaRaw = (cols[iFecha] || "").replace(/"/g, "").trim();
    if (!horaRaw || !horaRaw.includes("T")) continue;
    const fecha = horaRaw.split("T")[0];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) continue;
    const valor = parseVal(cols[iValor] || "");
    if (valor <= 0) continue;
    rows.push({
      adId, fecha, hora: horaRaw, valor,
      uid: iUid >= 0 ? (cols[iUid] || "").replace(/"/g, "").trim() : "",
      telefono: iTel >= 0 ? (cols[iTel] || "").replace(/"/g, "").trim() : "",
      producto: iProd >= 0 ? (cols[iProd] || "").replace(/"/g, "").trim() : "",
      cliente: iCli >= 0 ? (cols[iCli] || "").replace(/"/g, "").trim() : "",
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
// days=5 (auto-sync inteligente): solo últimos 5 días para capturar ajustes tardíos de Meta.
// days=90 (sync manual completo). days=0 = sin límite (Total).
async function syncSheet(job: { url: string; wsList: any[]; userId: string }, days = 90) {
  const sheetId = (job.url.match(/\/d\/([a-zA-Z0-9_-]+)/) || [])[1] || job.url;
  const res = await fetch(`https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv`);
  if (!res.ok) throw new Error(`Sheet ${job.url} no accesible (${res.status})`);
  const allRows = parseSheetCSV(await res.text());
  const fechaMin = days > 0 ? nDaysAgo(days) : "2000-01-01";
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
  // Acepta por Ad ID registrado O por nombre de producto que coincida con un workspace
  // (recupera ventas de creativos viejos no registrados).
  const rows = allAdIds.size
    ? recientes.filter((r) => allAdIds.has(r.adId) || !!wsNombreToId[normalizarProducto(r.producto || "", wsNames)])
    : recientes;
  if (!rows.length) return { ventas: 0, registros: 0, wsIds: [] };

  // Quitar SOLO filas byte-idénticas; los casi-duplicados suben para auditar en Conciliación.
  const seen = new Set<string>(); const unicas = [];
  for (const r of rows) { const k = `${r.adId}|${r.telefono}|${r.hora}|${r.valor}`; if (seen.has(k)) continue; seen.add(k); unicas.push(r); }

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
    if (r.hora && r.valor > 0) crmRows.push({ fecha: r.fecha, ad_id: r.adId, hora: r.hora, precio: r.valor, telefono: r.telefono || null, producto: r.producto || null, cliente: r.cliente || null, workspace_id: wsId, user_id: job.userId, fuente_uid: r.uid || null });
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

  // Espejo de métricas: si un (ws,ad,fecha) tenía ventas en el rango pero ya NO
  // aparece en el Sheet (venta borrada o movida a otro Ad ID), poner v1..v4 y
  // upsell en 0. NO se toca el gasto (viene de Meta), solo las ventas del Sheet.
  const regMapKeys = new Set(registros.map((r) => `${r.wsId}||${r.adId}||${r.fecha}`));
  for (const ws of job.wsList) {
    const conVentas = await sb("GET", `registros?workspace_id=eq.${ws.id}&fecha=gte.${fechaMin}&or=(v1.gt.0,v2.gt.0,v3.gt.0,v4.gt.0,upsell_total.gt.0)&select=ad_id,fecha`);
    for (const reg of (conVentas || [])) {
      const k = `${ws.id}||${reg.ad_id}||${reg.fecha}`;
      if (regMapKeys.has(k) || protegidos.has(k)) continue;
      await sb("PATCH", `registros?workspace_id=eq.${ws.id}&ad_id=eq.${enc(reg.ad_id)}&fecha=eq.${reg.fecha}`,
        { v1: 0, v2: 0, v3: 0, v4: 0, upsell_total: 0 }, "return=minimal").catch(() => {});
    }
  }

  // crm_ventas: sync por _uid (identidad estable). Las filas del Sheet con uid se
  // emparejan por fuente_uid → permiten editar/mover/borrar sin residuos. Las filas
  // sin uid todavía (recién llegadas, antes del trigger) usan el merge por conteo
  // legacy y NO participan del borrado en espejo.
  if (crmRows.length) {
    const wsIds = [...new Set(crmRows.map((r) => r.workspace_id))];
    const nowISO = new Date().toISOString();
    const hkey = (wsId: string, adId: string, hora: string, precio: number) =>
      `${wsId}|${adId}|${new Date(hora).getTime()}|${Math.round((+precio) * 100)}`;
    const push = (m: Map<string, any[]>, k: string, v: any) => { let a = m.get(k); if (!a) { a = []; m.set(k, a); } a.push(v); };

    // Estado actual en BD del rango
    const exByUid = new Map<string, any>();       // fuente_uid -> fila
    const exNoUid = new Map<string, any[]>();     // clave natural -> filas sin uid
    let totUidEnBD = 0;
    for (const wsId of wsIds) {
      const ex = await sbAll(`crm_ventas?workspace_id=eq.${wsId}&fecha=gte.${fechaMin}&select=id,ad_id,hora,precio,ciclo,historial,producto,cliente,telefono,fuente_uid,workspace_id`);
      for (const e of (ex || [])) {
        if (e.fuente_uid) { exByUid.set(e.fuente_uid, e); totUidEnBD++; }
        else push(exNoUid, hkey(wsId, e.ad_id, e.hora, +e.precio), e);
      }
    }

    const conUid = crmRows.filter((r) => r.fuente_uid);
    const sinUid = crmRows.filter((r) => !r.fuente_uid);
    const seenUids = new Set<string>();
    const faltaDato = (e: any, s: any) => (!e.producto && s.producto) || (!e.cliente && s.cliente) || (!e.telefono && s.telefono);

    // (1) Filas CON uid → emparejar/adoptar/insertar y actualizar cambios
    for (const r of conUid) {
      seenUids.add(r.fuente_uid);
      const e = exByUid.get(r.fuente_uid);
      if (e) {
        const cambios: any = {};
        if (e.ad_id !== r.ad_id) cambios.ad_id = r.ad_id;
        if (Math.abs((+e.precio) - (+r.precio)) > 0.001) cambios.precio = r.precio;
        if ((e.telefono || null) !== (r.telefono || null)) cambios.telefono = r.telefono || null;
        if ((e.cliente || null) !== (r.cliente || null)) cambios.cliente = r.cliente || null;
        if ((e.producto || null) !== (r.producto || null)) cambios.producto = r.producto || null;
        if (Object.keys(cambios).length) {
          const hist = Array.isArray(e.historial) ? e.historial : [];
          hist.push({ t: nowISO, accion: "Editada en Sheets", detalle: Object.keys(cambios).join(", ") });
          if (cambios.ad_id !== undefined || cambios.precio !== undefined) { cambios.ciclo = "pendiente"; cambios.estado_verif = "pendiente"; }
          cambios.sincronizado_at = nowISO; cambios.historial = hist;
          await sb("PATCH", `crm_ventas?id=eq.${e.id}`, cambios, "return=minimal").catch(() => {});
        }
      } else {
        // adoptar una fila legacy (sin uid) por clave natural, o insertar nueva
        const cand = exNoUid.get(hkey(r.workspace_id, r.ad_id, r.hora, +r.precio));
        const adopt = cand && cand.length ? cand.shift() : null;
        if (adopt) {
          await sb("PATCH", `crm_ventas?id=eq.${adopt.id}`, { fuente_uid: r.fuente_uid, sincronizado_at: nowISO }, "return=minimal").catch(() => {});
        } else {
          await sb("POST", "crm_ventas", [{
            fecha: r.fecha, ad_id: r.ad_id, hora: r.hora, precio: r.precio,
            telefono: r.telefono, producto: r.producto, cliente: r.cliente,
            workspace_id: r.workspace_id, user_id: job.userId, fuente_uid: r.fuente_uid,
            ciclo: "pendiente", estado_verif: "pendiente", origen: "auto", sincronizado_at: nowISO,
          }], "return=minimal").catch(() => {});
        }
      }
    }

    // (2) Filas SIN uid → merge por conteo legacy (insertar solo las copias que falten)
    if (sinUid.length) {
      const sheetByKey = new Map<string, any[]>();
      for (const r of sinUid) push(sheetByKey, hkey(r.workspace_id, r.ad_id, r.hora, +r.precio), r);
      const nuevos: any[] = [], modificados: any[] = [], enriquecer: any[] = [];
      for (const [k, sRows] of sheetByKey) {
        const eRows = exNoUid.get(k) || [];
        if (sRows.length === 1 && eRows.length === 1) {
          const s = sRows[0], e = eRows[0];
          if (Math.abs((+e.precio) - (+s.precio)) > 0.001) modificados.push({ ex: e, r: s });
          else if (faltaDato(e, s)) enriquecer.push({ ex: e, r: s });
        } else {
          const faltan = sRows.length - eRows.length;
          for (let i = 0; i < faltan; i++) nuevos.push(sRows[i] || sRows[0]);
          for (const e of eRows) if (faltaDato(e, sRows[0])) enriquecer.push({ ex: e, r: sRows[0] });
        }
      }
      for (let i = 0; i < nuevos.length; i += 100) {
        const lote = nuevos.slice(i, i + 100).map((r) => ({
          fecha: r.fecha, ad_id: r.ad_id, hora: r.hora, precio: r.precio,
          telefono: r.telefono, producto: r.producto, cliente: r.cliente,
          workspace_id: r.workspace_id, user_id: job.userId,
          ciclo: "pendiente", estado_verif: "pendiente", origen: "auto", sincronizado_at: nowISO,
        }));
        await sb("POST", "crm_ventas", lote, "return=minimal").catch(() => {});
      }
      for (const { ex, r } of modificados) {
        const hist = Array.isArray(ex.historial) ? ex.historial : [];
        hist.push({ t: nowISO, accion: "Modificada en Sheets", detalle: `monto ${ex.precio} → ${r.precio}` });
        await sb("PATCH", `crm_ventas?id=eq.${ex.id}`, {
          precio: r.precio, telefono: r.telefono || null, producto: r.producto || null, cliente: r.cliente || null,
          ciclo: "pendiente", estado_verif: "pendiente", sincronizado_at: nowISO, historial: hist,
        }, "return=minimal").catch(() => {});
      }
      for (const { ex, r } of enriquecer) {
        await sb("PATCH", `crm_ventas?id=eq.${ex.id}`, {
          producto: r.producto || null, cliente: r.cliente || null, telefono: r.telefono || null,
        }, "return=minimal").catch(() => {});
      }
    }

    // (3) Borrado en espejo: filas con uid en BD que ya NO están en el Sheet del rango.
    // Guardas de seguridad: solo si la lectura trajo uids y no es una anomalía masiva
    // (>60% de los uid del rango) que delataría un Sheet mal leído.
    if (seenUids.size > 0) {
      const aBorrar = [...exByUid.values()].filter((e: any) => !seenUids.has(e.fuente_uid));
      if (totUidEnBD > 0 && aBorrar.length / totUidEnBD <= 0.60) {
        for (const e of aBorrar) await sb("DELETE", `crm_ventas?id=eq.${e.id}`).catch(() => {});
      } else if (aBorrar.length) {
        console.warn(`Borrado en espejo OMITIDO (anomalía): borraría ${aBorrar.length}/${totUidEnBD} ventas con uid`);
      }
    }
  }

  return { ventas: unicas.length, registros: registros.length, wsIds: [...new Set(registros.map((r) => r.wsId))] };
}

// ── Meta gasto por fuente ──
async function syncMeta(fuente: any, wsList: any[]) {
  const cuentas = Array.isArray(fuente.meta_cuentas) ? fuente.meta_cuentas : [];
  if (!fuente.meta_token || !cuentas.length) return { filas: 0 };
  const desde = nDaysAgo(5), hasta = nDaysAgo(0);
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

// ── Consolidación + detección de eventos de alerta (devuelve alertas) ──
async function consolidar(wsId: string, ws: any): Promise<string[]> {
  const desde = nDaysAgo(6); const ahora = new Date(); const iso = ahora.toISOString();
  const rate = (ws.currency_code === "USD") ? 1 : (+ws.usd_rate || 3.7);
  const emoji = ws.emoji || "📦";
  const cfg = (await sb("GET", `config?workspace_id=eq.${wsId}&select=p1,p2,p3,p4&limit=1`))?.[0] || { p1: 10, p2: 7, p3: 5, p4: 3 };
  const regs = await sb("GET", `registros?workspace_id=eq.${wsId}&fecha=gte.${desde}&select=fecha,gasto_meta,gasto_tiktok,v1,v2,v3,v4,upsell_total`);
  const estados = await sb("GET", `dia_estado?workspace_id=eq.${wsId}&fecha=gte.${desde}`);
  const agg: Record<string, { gasto: number; ing: number }> = {};
  (regs || []).forEach((r: any) => {
    const a = agg[r.fecha] || (agg[r.fecha] = { gasto: 0, ing: 0 });
    a.gasto += (+r.gasto_meta || 0) + (+r.gasto_tiktok || 0);
    a.ing += (+r.v1 || 0) * (+cfg.p1) + (+r.v2 || 0) * (+cfg.p2) + (+r.v3 || 0) * (+cfg.p3) + (+r.v4 || 0) * (+cfg.p4) + (+r.upsell_total || 0);
  });
  const estMap: Record<string, any> = {}; (estados || []).forEach((e: any) => { estMap[e.fecha] = e; });
  const alertas: string[] = [];
  let algoConsolido = false;

  for (const [fecha, a] of Object.entries(agg)) {
    const g = +a.gasto.toFixed(2);
    const profitUsd = +((a.ing - g) / rate).toFixed(2);
    const ingUsd = +(a.ing / rate).toFixed(2);
    const e = estMap[fecha];
    if (!e) {
      await sb("POST", "dia_estado", [{ workspace_id: wsId, user_id: ws.user_id, fecha, gasto_total: g, gasto_anterior: g, gasto_provisional: g, ingresos_usd: ingUsd, profit_usd: profitUsd, primer_sync_at: iso, ultimo_cambio_at: iso, consolidado: fecha <= diaPeru(-2), usd_rate: rate }], "return=minimal").catch(() => {});
      continue;
    }
    if (e.consolidado) continue;
    const patch: any = { ingresos_usd: ingUsd, profit_usd: profitUsd };
    if (Math.abs(g - (+e.gasto_total || 0)) > 0.001) { patch.gasto_anterior = e.gasto_total; patch.gasto_total = g; patch.ultimo_cambio_at = iso; }
    // Modelo por antigüedad: 2+ días → firme (Meta estabiliza en ~48h)
    const consolidaAhora = fecha <= diaPeru(-2);
    if (consolidaAhora) { patch.consolidado = true; patch.consolidado_at = iso; patch.usd_rate = rate; patch.gasto_total = g; }
    await sb("PATCH", `dia_estado?id=eq.${e.id}`, patch, "return=minimal").catch(() => {});

    if (consolidaAhora) {
      algoConsolido = true;
      // 🔴 Cambio de signo: profit con gasto provisional vs gasto final
      const profProv = +((a.ing - (+e.gasto_provisional || g)) / rate).toFixed(2);
      if ((profProv >= 0) !== (profitUsd >= 0) && Math.abs(profProv - profitUsd) > 0.01) {
        alertas.push(`⚠️ *Cambio de signo* — ${emoji} ${ws.nombre}\nEl ${fecha} se consolidó en *${profitUsd >= 0 ? "GANANCIA" : "PÉRDIDA"}*: ${fUsd(profitUsd)} (provisional decía ${fUsd(profProv)}).`);
      }
      // 🏆 Récord del mes
      if (profitUsd > 0) {
        try {
          const mesIni = fecha.slice(0, 8) + "01";
          const mesDias = await sb("GET", `dia_estado?workspace_id=eq.${wsId}&fecha=gte.${mesIni}&fecha=lte.${fecha}&consolidado=eq.true&select=fecha,profit_usd`);
          const maxOtros = Math.max(0, ...(mesDias || []).filter((d: any) => d.fecha !== fecha).map((d: any) => +d.profit_usd || 0));
          if (maxOtros > 0 && profitUsd > maxOtros) alertas.push(`🏆 *Récord del mes* — ${emoji} ${ws.nombre}\nEl ${fecha} es tu mejor día del mes: *${fUsd(profitUsd)}* de profit.`);
        } catch (_) { /* */ }
      }
    }
  }

  // 📉 Racha negativa (solo si algo se consolidó en este run, para no repetir)
  if (algoConsolido) {
    try {
      const rec = await sb("GET", `dia_estado?workspace_id=eq.${wsId}&consolidado=eq.true&order=fecha.desc&limit=6&select=fecha,profit_usd`);
      let racha = 0, acum = 0;
      for (const d of (rec || [])) { if ((+d.profit_usd || 0) < 0) { racha++; acum += (+d.profit_usd || 0); } else break; }
      if (racha >= 2) alertas.push(`📉 *Racha negativa* — ${emoji} ${ws.nombre}\n${racha} días consolidados seguidos en pérdida (${fUsd(acum)} acumulado). Revisa tus anuncios activos.`);
    } catch (_) { /* */ }
  }
  return alertas;
}

// Procesa todas las fuentes de un usuario (ventas + opcional Meta + consolidación)
// sheetDays: cuántos días atrás leer del Sheet (5 para auto-sync inteligente, 90 para manual)
async function procesarUsuario(userId: string, conMeta: boolean, sheetDays = 5) {
  const fuentes = await sb("GET", `fuentes?user_id=eq.${userId}`);
  const workspaces = await sb("GET", `workspaces?user_id=eq.${userId}`);
  const wsTouched = new Set<string>();
  let totVentas = 0;
  for (const f of (fuentes || [])) {
    const wsList = (workspaces || []).filter((w: any) => w.fuente_id === f.id);
    const wsForJob = wsList.length ? wsList : workspaces;
    if (f.sheets_url) {
      try {
        const r = await syncSheet({ url: f.sheets_url, wsList: wsForJob, userId }, sheetDays);
        totVentas += r.ventas; r.wsIds.forEach((id) => wsTouched.add(id));
      } catch (e) { console.error("syncSheet", f.nombre, e); }
    }
    if (conMeta) {
      try { await syncMeta(f, wsForJob); (wsForJob || []).forEach((w: any) => wsTouched.add(w.id)); }
      catch (e) { console.error("syncMeta", f.nombre, e); }
    }
  }
  const alertas: string[] = [];
  for (const wsId of wsTouched) {
    const ws = (workspaces || []).find((w: any) => w.id === wsId);
    if (ws) { const al = await consolidar(wsId, ws).catch(() => [] as string[]); alertas.push(...al); }
  }

  // ⏰ Recordatorios diarios por fuente: token de Meta (≤30 días) y pago del bot (≤7 días).
  // La gravedad aumenta conforme se acerca la fecha.
  for (const f of (fuentes || [])) {
    // Token de Meta por caducar
    if (conMeta && f.meta_token) {
      try {
        const r = await fetch(`https://graph.facebook.com/v19.0/debug_token?input_token=${f.meta_token}&access_token=${f.meta_token}`);
        const jd = await r.json();
        const exp = jd?.data?.expires_at; // 0 = no expira (system user)
        if (exp && exp > 0) {
          const dias = Math.ceil((exp * 1000 - Date.now()) / 86400000);
          if (dias >= 0 && dias <= 30) {
            const urgencia = dias <= 3 ? "🔴 *URGENTE*" : dias <= 7 ? "🟡 *ATENCIÓN*" : "⏰ *Aviso*";
            alertas.push(`${urgencia} — El *token de Meta* de ${f.emoji || "🤖"} ${f.nombre} caduca en *${dias} día(s)*.\nGenera uno nuevo en Meta Business → Sistema → Usuarios → Token, y actualízalo en Ajustes → Fuentes antes de que venza, o el gasto dejará de sincronizar.`);
          }
        }
      } catch (_) { /* */ }
    }
    // Pago del bot (mensual) por vencer
    const pago = nextDueDate(f.pago_vence);
    if (pago && pago.dias >= 0 && pago.dias <= 7) {
      const urgencia = pago.dias <= 2 ? "🔴 *URGENTE*" : pago.dias <= 5 ? "🟡 *ATENCIÓN*" : "⏰ *Aviso*";
      alertas.push(`${urgencia} — El *pago del bot* ${f.emoji || "🤖"} ${f.nombre} vence en *${pago.dias} día(s)* (${pago.date}).\nRenuévalo antes para no perder el servicio del bot.`);
    }
  }
  return { userId, ventas: totVentas, workspaces: wsTouched.size, alertas };
}

// Modo programado: lee sync_config de cada usuario y dispara según sus horas (Perú UTC-5)
async function runScheduled() {
  const peru = new Date(Date.now() - 5 * 3600 * 1000);
  const nowMin = peru.getUTCHours() * 60 + peru.getUTCMinutes();
  const hoy = peru.toISOString().slice(0, 10);
  const toMin = (hhmm: string) => { const [h, m] = (hhmm || "").split(":").map(Number); return (h || 0) * 60 + (m || 0); };
  const cfgs = await sb("GET", "sync_config?activo=eq.true").catch(() => []);
  const ejecutados: any[] = [];
  const errores: any[] = [];
  for (const cfg of (cfgs || [])) {
    // Noche (con Meta) tiene prioridad; luego mañana (solo ventas)
    const enviarAlertas = async (r: any) => {
      if (cfg.tg_token && cfg.tg_chat_id && cfg.tg_activo !== false && cfg.tg_alertas !== false)
        for (const a of (r.alertas || [])) await tgSend(cfg.tg_token, cfg.tg_chat_id, a).catch(() => {});
    };
    // Cada slot va protegido: un fallo en un usuario/workspace no debe abortar la corrida
    // completa (eso dejaba ultima_* sin marcar y bloqueaba el Telegram de todos).
    const correrSlot = async (slot: "noche" | "manana", marca: Record<string, string>) => {
      try {
        const r = await procesarUsuario(cfg.user_id, true);
        // Marcar PRIMERO para no reintentar en loop cada 15 min si Telegram/alertas fallan
        await sb("PATCH", `sync_config?user_id=eq.${cfg.user_id}`, marca, "return=minimal").catch(() => {});
        await enviarAlertas(r);
        await enviarReporteSlot(cfg, slot).catch((e) => console.error("reporte " + slot, e));
        ejecutados.push({ ...r, slot });
      } catch (e) {
        // Igual marcamos el slot para no entrar en bucle de reintentos fallidos cada 15 min
        await sb("PATCH", `sync_config?user_id=eq.${cfg.user_id}`, marca, "return=minimal").catch(() => {});
        errores.push({ user_id: cfg.user_id, slot, error: String((e as Error)?.message || e) });
        console.error("slot " + slot + " user " + cfg.user_id, e);
      }
    };
    let corrio = false;
    if (nowMin >= toMin(cfg.hora_noche || "23:00") && cfg.ultima_noche !== hoy) {
      await correrSlot("noche", { ultima_noche: hoy }); corrio = true;
    } else if (nowMin >= toMin(cfg.hora_manana || "06:30") && cfg.ultima_manana !== hoy) {
      // La mañana también trae Meta: captura el gasto ya consolidado durante la noche
      await correrSlot("manana", { ultima_manana: hoy }); corrio = true;
    }
    // Sincronización por INTERVALO (cada N min, programable desde la app; corre con la app CERRADA).
    // El cron ya invoca esta función ~cada 15 min, así que el intervalo efectivo mínimo es 15 min.
    const interv = +cfg.intervalo_min || 0;
    if (!corrio && interv > 0) {
      const last = cfg.ultima_intervalo ? new Date(cfg.ultima_intervalo).getTime() : 0;
      if (Date.now() - last >= interv * 60000) {
        const marca = { ultima_intervalo: new Date().toISOString() };
        try {
          const r = await procesarUsuario(cfg.user_id, true);
          await sb("PATCH", `sync_config?user_id=eq.${cfg.user_id}`, marca, "return=minimal").catch(() => {});
          await enviarAlertas(r);                       // alertas sí; reporte completo NO (evita spam por intervalo)
          ejecutados.push({ ...r, slot: "intervalo" });
        } catch (e) {
          await sb("PATCH", `sync_config?user_id=eq.${cfg.user_id}`, marca, "return=minimal").catch(() => {});
          errores.push({ user_id: cfg.user_id, slot: "intervalo", error: String((e as Error)?.message || e) });
        }
      }
    }
  }
  return json({ ok: true, scheduled: true, version: FN_VERSION, hora_peru: `${String(peru.getUTCHours()).padStart(2, "0")}:${String(peru.getUTCMinutes()).padStart(2, "0")}`, ejecutados, errores });
}

// ════════════════════════════════════════════════
// TELEGRAM — Reportes (Etapa 6)
// ════════════════════════════════════════════════
const CUR: Record<string, { s: string; d: number }> = {
  USD: { s: "$", d: 2 }, PEN: { s: "S/", d: 2 }, COP: { s: "$", d: 0 }, MXN: { s: "$", d: 2 },
  CLP: { s: "$", d: 0 }, ARS: { s: "$", d: 0 }, BOB: { s: "Bs", d: 2 }, BRL: { s: "R$", d: 2 },
  GTQ: { s: "Q", d: 2 }, DOP: { s: "RD$", d: 2 }, EUR: { s: "€", d: 2 },
};
const fMoney = (n: number, code: string) => { const c = CUR[code] || CUR.PEN; const neg = (+n || 0) < 0; return `${neg ? "-" : ""}${c.s}${Math.abs(+n || 0).toFixed(c.d).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`; };
const fUsd = (n: number) => { const neg = (+n || 0) < 0; return `${neg ? "-" : ""}$${Math.abs(+n || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`; };
const fRoas = (n: number) => isFinite(n) && n > 0 ? `${n.toFixed(2)}x` : "—";
const fRoi = (profit: number, inv: number) => inv > 0 ? `${(profit / inv * 100).toFixed(1)}%` : "—";
// Nombre de país por moneda (para el bloque local del resumen: "PERÚ (PEN)").
const PAIS: Record<string, string> = {
  PEN: "PERÚ", COP: "COLOMBIA", MXN: "MÉXICO", CLP: "CHILE", ARS: "ARGENTINA",
  BOB: "BOLIVIA", BRL: "BRASIL", GTQ: "GUATEMALA", DOP: "REP. DOMINICANA", EUR: "EUROPA", USD: "USD",
};
const MESES_COR = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
const fFechaCorta = (iso: string) => { const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? `${m[3]} ${MESES_COR[+m[2] - 1]} ${m[1]}` : iso; };
// Bandera por moneda (bloque local del resumen).
const FLAG: Record<string, string> = {
  PEN: "🇵🇪", COP: "🇨🇴", MXN: "🇲🇽", CLP: "🇨🇱", ARS: "🇦🇷", BOB: "🇧🇴",
  BRL: "🇧🇷", GTQ: "🇬🇹", DOP: "🇩🇴", EUR: "🇪🇺", USD: "🇺🇸",
};
// Barra divisora (entre productos / alrededor de CONFIRMADOS).
const BAR = "━━━━━━━━";
// Encabezado de sección: barras CORTAS e iguales a cada lado para que el título
// quepa en una sola línea y se vea centrado (Telegram no permite centrar de verdad).
const secHdr = (emoji: string, t: string) => `\n\n━━━ ${emoji} *${t}* ━━━\n`;
const diaPeru = (off = 0) => { const d = new Date(Date.now() - 5 * 3600 * 1000); d.setUTCDate(d.getUTCDate() + off); return d.toISOString().slice(0, 10); };
const lunesDe = (fechaStr: string) => { const d = new Date(fechaStr + "T12:00:00Z"); const dow = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - dow); return d.toISOString().slice(0, 10); };
// Fecha de pago del bot (mensual recurrente): rueda la fecha base mes a mes hasta
// que sea >= hoy. Así el usuario la fija una vez y se renueva sola cada mes.
function nextDueDate(venceStr: string | null | undefined): { date: string; dias: number } | null {
  if (!venceStr) return null;
  const base = new Date(venceStr + "T12:00:00Z");
  if (isNaN(base.getTime())) return null;
  const now = new Date();
  const d = new Date(base);
  let guard = 0;
  while (d.getTime() < now.getTime() && guard < 600) { d.setUTCMonth(d.getUTCMonth() + 1); guard++; }
  const dias = Math.ceil((d.getTime() - now.getTime()) / 86400000);
  return { date: d.toISOString().slice(0, 10), dias };
}

async function tgSend(token: string, chatId: string, text: string, keyboard?: any[]) {
  const body: any = { chat_id: chatId, text, parse_mode: "Markdown", disable_web_page_preview: true };
  if (keyboard) body.reply_markup = { inline_keyboard: keyboard };
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => {});
}
// Teclado de acciones rápidas bajo los reportes
const reportKb = () => [
  [{ text: "📅 Semana", callback_data: "semana" }, { text: "🗓️ Mes", callback_data: "mes" }],
  [{ text: "⏳ Pendientes", callback_data: "pendientes" }, { text: "🏆 Mejores", callback_data: "mejores" }],
];
async function sbCount(path: string): Promise<number> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: "HEAD", headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, Prefer: "count=exact", Range: "0-0" },
  });
  const cr = res.headers.get("content-range") || "*/0";
  return parseInt(cr.split("/")[1] || "0") || 0;
}

// Reúne métricas por workspace para un rango.
// Ingresos PROYECTADOS (todas menos descartadas) y CONFIRMADOS (solo validadas)
// salen de la RPC ingresos_ciclo (suma crm_ventas.precio sin tope de filas).
async function reportData(userId: string, desde: string, hasta: string) {
  const workspaces = await sb("GET", `workspaces?user_id=eq.${userId}`);
  const fuentes = await sb("GET", `fuentes?user_id=eq.${userId}`);
  const fuenteName: Record<string, string> = {};
  (fuentes || []).forEach((f: any) => { fuenteName[f.id] = `${f.emoji || "🤖"} ${f.nombre}`; });
  // Ingresos por ciclo (Proyectado/Confirmado) vía RPC; fallback vacío si no existe.
  const rpc = await sb("POST", "rpc/ingresos_ciclo", { p_desde: desde, p_hasta: hasta }).catch(() => []);
  const ingMap: Record<string, any> = {};
  (rpc || []).forEach((r: any) => { ingMap[r.workspace_id] = r; });
  const perWs: any[] = [];
  for (const ws of (workspaces || [])) {
    const cfg = (await sb("GET", `config?workspace_id=eq.${ws.id}&select=p1,p2,p3,p4&limit=1`))?.[0] || { p1: 10, p2: 7, p3: 5, p4: 3 };
    const regs = await sb("GET", `registros?workspace_id=eq.${ws.id}&fecha=gte.${desde}&fecha=lte.${hasta}&select=fecha,gasto_meta,gasto_tiktok,v1,v2,v3,v4,upsell_total`) || [];
    let inv = 0, up = 0, v1 = 0, v2 = 0, v3 = 0, v4 = 0;
    regs.forEach((r: any) => { inv += (+r.gasto_meta || 0) + (+r.gasto_tiktok || 0); v1 += +r.v1 || 0; v2 += +r.v2 || 0; v3 += +r.v3 || 0; v4 += +r.v4 || 0; up += +r.upsell_total || 0; });
    const ingReg = v1 * (+cfg.p1) + v2 * (+cfg.p2) + v3 * (+cfg.p3) + v4 * (+cfg.p4) + up; // fallback
    const ic = ingMap[ws.id] || {};
    const ingProy = ic.ing_proyectado != null ? +ic.ing_proyectado : ingReg;
    const ingConf = +ic.ing_confirmado || 0;
    const nTotal = +ic.n_total || 0, nConf = +ic.n_confirmado || 0;
    const rate = ws.currency_code === "USD" ? 1 : (+ws.usd_rate || 3.7);
    const estados = await sb("GET", `dia_estado?workspace_id=eq.${ws.id}&fecha=gte.${desde}&fecha=lte.${hasta}&select=fecha,consolidado`) || [];
    const consMap: Record<string, boolean> = {}; estados.forEach((e: any) => { consMap[e.fecha] = e.consolidado; });
    const diasData = [...new Set(regs.map((r: any) => r.fecha))] as string[];
    let prov = 0; diasData.forEach((f) => { const c = consMap[f] !== undefined ? consMap[f] : (f < diaPeru(-2)); if (!c) prov++; });
    perWs.push({ ws, inv, ingProy, ingConf, v1, v2, v3, v4, ventas: v1 + v2 + v3 + v4, rate, prov, nTotal, nConf, dias: diasData.length });
  }
  return { perWs, fuenteName };
}

// Moneda local para el global: la del producto (no USD) con más ingresos proyectados.
function dispCurrency(perWs: any[]): { code: string; rate: number } | null {
  const cands = perWs.filter((w: any) => w.ws.currency_code && w.ws.currency_code !== "USD")
    .sort((a: any, b: any) => (b.ingProy / b.rate) - (a.ingProy / a.rate));
  return cands.length ? { code: cands[0].ws.currency_code, rate: cands[0].rate } : null;
}

// Formato unificado de TODOS los reportes/comandos de Telegram (estructura del PDF):
//   RESUMEN GLOBAL (KPIs Proyectados + Confirmados, USD + moneda local) →
//   PRODUCTOS (Profit/ROAS/Ventas + desglose P1–P4) → ALERTAS.
// El bloque ESTADO DEL SISTEMA se añade aparte (estadoSistemaBlock) donde aplica.
function formatReport(titulo: string, periodoTxt: string, data: any) {
  const { perWs } = data;
  let gInv = 0, gProy = 0, gConf = 0, gVen = 0, gNTotal = 0, gNConf = 0, prov = 0;
  perWs.forEach((w: any) => {
    gInv += w.inv / w.rate; gProy += w.ingProy / w.rate; gConf += w.ingConf / w.rate;
    gVen += w.ventas; gNTotal += w.nTotal; gNConf += w.nConf; prov += w.prov;
  });
  const profProy = gProy - gInv, profConf = gConf - gInv;
  const roasProy = gInv > 0 ? gProy / gInv : 0, roasConf = gInv > 0 ? gConf / gInv : 0;
  const pend = Math.max(gNTotal - gNConf, 0);
  const dc = dispCurrency(perWs);
  const dShow = (usd: number) => dc ? fMoney(usd * dc.rate, dc.code) : fUsd(usd);

  // ── Encabezado ──
  let msg = `${titulo}\n📅 _${periodoTxt}_`;

  // ── RESUMEN GLOBAL ──
  msg += secHdr("🌍", "RESUMEN GLOBAL");
  msg += `\n🟡 *KPIs PROYECTADOS*`;
  msg += `\n💰 *Ingresos* ${fUsd(gProy)}`;
  msg += `\n📢 *Inversión* ${fUsd(gInv)}`;
  msg += `\n🟢 *Profit* ${fUsd(profProy)}`;
  msg += `\n📈 *ROAS* ${fRoas(roasProy)}`;
  msg += `\n🚀 *ROI* ${fRoi(profProy, gInv)}`;
  msg += `\n🛒 *Ventas* ${gVen}`;
  if (dc) {
    msg += `\n${FLAG[dc.code] || "🏳️"} *${PAIS[dc.code] || dc.code} (${dc.code})*`;
    msg += `\n💰 *Ingresos* ${fMoney(gProy * dc.rate, dc.code)}`;
    msg += `\n📢 *Inversión* ${fMoney(gInv * dc.rate, dc.code)}`;
    msg += `\n🟢 *Profit* ${fMoney(profProy * dc.rate, dc.code)}`;
  }
  msg += `\n🟡 Incluye ventas pendientes de conciliación.`;
  msg += `\n🟡 *${pend} pendientes*`;

  // KPIs CONFIRMADOS
  msg += `\n${BAR}\n🟢 *KPIs CONFIRMADOS*\n${BAR}`;
  msg += `\n💰 *Ingresos* ${dShow(gConf)}`;
  msg += `\n🟢 *Profit* ${dShow(profConf)}`;
  msg += `\n📈 *ROAS* ${fRoas(roasConf)}`;
  msg += `\n🚀 *ROI* ${fRoi(profConf, gInv)}`;
  msg += `\n🟢 Solo incluye pagos verificados.`;
  msg += `\n✅ *${gNConf} verificadas*`;

  // ── PRODUCTOS (ordenados por profit proyectado local) ──
  msg += secHdr("🏆", "PRODUCTOS");
  const sorted = [...perWs].sort((a: any, b: any) => ((b.ingProy - b.inv) / b.rate) - ((a.ingProy - a.inv) / a.rate));
  const medals = ["🥇", "🥈", "🥉"];
  sorted.forEach((w: any, i: number) => {
    const code = w.ws.currency_code || "PEN";
    const medal = medals[i] || "📦";
    if (i > 0) msg += `\n${BAR}`;
    msg += `\n${medal} ${w.ws.emoji || "📦"} *${w.ws.nombre}*`;
    if (w.ventas === 0 && w.inv === 0) { msg += `\n⚪ *Sin actividad.*`; return; }
    const profL = w.ingProy - w.inv;
    const roas = w.inv > 0 ? w.ingProy / w.inv : 0;
    const ps = profL >= 0 ? "🟢" : "🔴";
    msg += `\n${ps} *Profit:* ${fMoney(profL, code)}`;
    msg += `\n📈 *ROAS:* ${fRoas(roas)}`;
    msg += `\n🛒 *Ventas:* ${w.ventas}`;
    msg += `\nP1 *${w.v1}* | P2 *${w.v2}*`;
    msg += `\nP3 *${w.v3}* | P4 *${w.v4}*`;
  });

  // ── ALERTAS ──
  msg += secHdr("⚠️", "ALERTAS");
  if (prov > 0) {
    msg += `\n⏳ *${prov} días provisionales.*\nEl gasto de Meta aún puede ajustarse.`;
  } else {
    msg += `\n✅ Sin alertas. Todo consolidado.`;
  }
  return msg;
}

// Envía el reporte de un slot tras la sync programada
// Genera líneas de estado (token de Meta + pago del bot) para el reporte de la mañana
async function tokenStatusLine(userId: string): Promise<string> {
  const fuentes = await sb("GET", `fuentes?user_id=eq.${userId}`).catch(() => []);
  const multi = (fuentes || []).length > 1;
  const lines: string[] = [];
  for (const f of (fuentes || [])) {
    const suf = multi ? ` · ${f.nombre}` : "";
    if (f.meta_token) {
      try {
        const r = await fetch(`https://graph.facebook.com/v19.0/debug_token?input_token=${f.meta_token}&access_token=${f.meta_token}`);
        const jd = await r.json();
        const exp = jd?.data?.expires_at;
        if (!exp || exp === 0) {
          lines.push(`🟢 *Meta Token*${suf} sin caducidad`);
        } else {
          const dias = Math.ceil((exp * 1000 - Date.now()) / 86400000);
          const icon = dias <= 3 ? "🔴" : dias <= 7 ? "🟡" : dias <= 30 ? "🟠" : "🟢";
          lines.push(`${icon} *Meta Token*${suf} ${dias} días restantes`);
        }
      } catch (_) { lines.push(`⚠️ *Meta Token*${suf} no verificado`); }
    }
    const pago = nextDueDate(f.pago_vence);
    if (pago) {
      const icon = pago.dias <= 2 ? "🔴" : pago.dias <= 5 ? "🟡" : pago.dias <= 7 ? "🟠" : "🟢";
      lines.push(`${icon} *${f.emoji || "🤖"} ${f.nombre}* ${pago.dias} días restantes\n📅 *Vence: ${fFechaCorta(pago.date)}*`);
    }
  }
  if (!lines.length) return "";
  return `${secHdr("🔐", "ESTADO DEL SISTEMA")}\n${lines.join("\n")}`;
}

async function enviarReporteSlot(cfg: any, slot: "noche" | "manana") {
  if (!cfg.tg_token || !cfg.tg_chat_id || cfg.tg_activo === false) return;
  if (slot === "noche") {
    const hoy = diaPeru(0);
    const data = await reportData(cfg.user_id, hoy, hoy);
    const est = await tokenStatusLine(cfg.user_id).catch(() => "");
    await tgSend(cfg.tg_token, cfg.tg_chat_id, formatReport("🌙 *CIERRE DEL DÍA*", `Hoy · ${fFechaCorta(hoy)}`, data) + est, reportKb());
  } else {
    const ayer = diaPeru(-1);
    const data = await reportData(cfg.user_id, ayer, ayer);
    // El reporte de mañana siempre incluye el estado del token de Meta
    const tokLine = await tokenStatusLine(cfg.user_id).catch(() => "");
    const msg = formatReport("☀️ *BUENOS DÍAS*", `Ayer · ${fFechaCorta(ayer)}`, data) + tokLine;
    await tgSend(cfg.tg_token, cfg.tg_chat_id, msg, reportKb());
  }
}

const AYUDA = `🤖 *Comandos de Tracker Pro*\n\n🔄 /sync — sincronizar ahora (últimos 5 días)\n🔍 /estado — tokens Meta, pago de bots y horarios del auto-sync\n\n📊 *Reportes:*\n/hoy · /ayer · /año\n/semana — semana actual\n/semana DD/MM — semana de esa fecha\n/mes — mes actual\n/mes mayo · /mes 05/2025 — mes específico\n/dia DD/MM — un día (año actual)\n/dia DD/MM/AAAA — un día con año\n\n🔎 *Detalle:*\n/producto <nombre> — un producto\n/bot <nombre> — una fuente/bot\n/mejores — top y peores anuncios (7 días)\n/pendientes — días provisionales + ventas sin verificar\n\n_Recibes el cierre nocturno y el buenos días automáticamente, más alertas de cambio de signo, récords y rachas._`;

// /pendientes — días provisionales + ventas sin verificar
async function cmdPendientes(userId: string) {
  const desde = diaPeru(-30);
  const workspaces = await sb("GET", `workspaces?user_id=eq.${userId}&select=id,nombre,emoji`);
  let msg = `⏳ *PENDIENTES*\n_Últimos 30 días_\n━━━━━━━━━━━━━━━\n📦 *PRODUCTOS*`;
  let nada = true;
  for (const ws of (workspaces || [])) {
    const prov = await sb("GET", `dia_estado?workspace_id=eq.${ws.id}&fecha=gte.${desde}&consolidado=eq.false&select=fecha&order=fecha.desc`);
    const sinVerif = await sbCount(`crm_ventas?workspace_id=eq.${ws.id}&fecha=gte.${desde}&ciclo=neq.finalizado&ciclo=neq.descartado`);
    if ((prov || []).length || sinVerif) {
      nada = false;
      msg += `\n\n*${ws.emoji || "📦"} ${ws.nombre}*`;
      if ((prov || []).length) msg += `\n⏳ ${prov.length} día(s) provisional(es): ${prov.slice(0, 6).map((d: any) => fFechaCorta(d.fecha)).join(", ")}`;
      if (sinVerif) msg += `\n🔎 ${sinVerif} venta(s) sin verificar`;
    }
  }
  if (nada) msg += "\n\n✅ Todo consolidado y verificado.";
  return msg;
}

// /mejores — top y peores anuncios del período
async function cmdMejores(userId: string, desde: string, hasta: string) {
  const workspaces = await sb("GET", `workspaces?user_id=eq.${userId}&select=id,nombre,emoji,currency_code`);
  const all: any[] = [];
  for (const ws of (workspaces || [])) {
    const cfg = (await sb("GET", `config?workspace_id=eq.${ws.id}&select=p1,p2,p3,p4&limit=1`))?.[0] || { p1: 10, p2: 7, p3: 5, p4: 3 };
    const ads = await sb("GET", `anuncios?workspace_id=eq.${ws.id}&select=ad_id,nombre`);
    const nm: Record<string, string> = {}; (ads || []).forEach((a: any) => { nm[a.ad_id] = a.nombre || a.ad_id; });
    const regs = await sb("GET", `registros?workspace_id=eq.${ws.id}&fecha=gte.${desde}&fecha=lte.${hasta}&select=ad_id,gasto_meta,gasto_tiktok,v1,v2,v3,v4,upsell_total`);
    const byAd: Record<string, { g: number; ing: number }> = {};
    (regs || []).forEach((r: any) => {
      const a = byAd[r.ad_id] || (byAd[r.ad_id] = { g: 0, ing: 0 });
      a.g += (+r.gasto_meta || 0) + (+r.gasto_tiktok || 0);
      a.ing += (+r.v1 || 0) * (+cfg.p1) + (+r.v2 || 0) * (+cfg.p2) + (+r.v3 || 0) * (+cfg.p3) + (+r.v4 || 0) * (+cfg.p4) + (+r.upsell_total || 0);
    });
    for (const [adId, a] of Object.entries(byAd)) {
      if (a.g < 1) continue;
      all.push({ nombre: nm[adId] || adId, emoji: ws.emoji || "📦", roas: a.g > 0 ? a.ing / a.g : 0, code: ws.currency_code || "PEN" });
    }
  }
  if (!all.length) return `🏆 *MEJORES Y PEORES*\n_${fFechaCorta(desde)} → ${fFechaCorta(hasta)}_\n━━━━━━━━━━━━━━━\nSin datos con gasto en el período.`;
  all.sort((x, y) => y.roas - x.roas);
  const top = all.slice(0, 3), peor = all.slice(-3).reverse();
  let msg = `🏆 *MEJORES Y PEORES*\n_${fFechaCorta(desde)} → ${fFechaCorta(hasta)}_`;
  msg += `\n━━━━━━━━━━━━━━━\n✅ *TOP ROAS*`;
  top.forEach((a, i) => { msg += `\n${i + 1}. ${a.emoji} ${a.nombre} — *${fRoas(a.roas)}*`; });
  msg += `\n━━━━━━━━━━━━━━━\n🔻 *PEORES ROAS*`;
  peor.forEach((a) => { msg += `\n• ${a.emoji} ${a.nombre} — ${fRoas(a.roas)}`; });
  return msg;
}

// Ejecuta un comando y envía la respuesta
async function tgRunCommand(userId: string, cfg: any, chatId: string, cmd: string, arg: string) {
  if (cmd === "/ayuda" || cmd === "/help") { await tgSend(cfg.tg_token, chatId, AYUDA); return; }

  // Sincronizar ahora (últimos 5 días) desde Telegram — igual que el auto-sync
  if (cmd === "/sync") {
    await tgSend(cfg.tg_token, chatId, "⏳ Sincronizando últimos 5 días...");
    const r = await procesarUsuario(userId, true, 5);
    for (const a of (r.alertas || [])) await tgSend(cfg.tg_token, chatId, a);
    await tgSend(cfg.tg_token, chatId, `✅ Sincronizado: ${r.ventas} ventas · ${r.workspaces} producto(s)`);
    return;
  }

  // Verificar tokens de Meta y horarios del auto-sync
  if (cmd === "/testtoken" || cmd === "/estado") {
    const fuentes = await sb("GET", `fuentes?user_id=eq.${userId}`).catch(() => []);
    const syncCfg = (await sb("GET", `sync_config?user_id=eq.${userId}&limit=1`).catch(() => []))?.[0];
    let msg = "🔍 *Estado del sistema*\n\n";
    // Horarios
    msg += `⏰ *Auto-sync:* ${syncCfg?.activo !== false ? "✅ Activo" : "⏸️ Pausado"}\n`;
    msg += `🌙 Noche: ${syncCfg?.hora_noche || "23:00"} · ☀️ Mañana: ${syncCfg?.hora_manana || "06:30"}\n`;
    if (syncCfg?.ultima_noche)  msg += `Última noche: ${syncCfg.ultima_noche}\n`;
    if (syncCfg?.ultima_manana) msg += `Última mañana: ${syncCfg.ultima_manana}\n`;
    msg += "\n";
    // Por cada fuente (bot): token de Meta + vencimiento del pago del bot
    for (const f of (fuentes || [])) {
      msg += `🤖 *${f.nombre}*\n`;
      // Token de Meta
      if (!f.meta_token) {
        msg += `   🔑 Token: _sin configurar_\n`;
      } else {
        try {
          const r = await fetch(`https://graph.facebook.com/v19.0/debug_token?input_token=${f.meta_token}&access_token=${f.meta_token}`);
          const jd = await r.json();
          const exp = jd?.data?.expires_at;
          if (!exp || exp === 0) {
            msg += `   🟢 Token: sin caducidad (sistema)\n`;
          } else {
            const dias = Math.ceil((exp * 1000 - Date.now()) / 86400000);
            const icon = dias <= 3 ? "🔴" : dias <= 7 ? "🟡" : dias <= 30 ? "🟠" : "🟢";
            const expDate = new Date(exp * 1000).toISOString().slice(0, 10);
            msg += `   ${icon} Token: caduca en *${dias} día(s)* (${expDate})\n`;
          }
        } catch (_) { msg += `   ⚠️ Token: no se pudo verificar\n`; }
      }
      // Vencimiento del pago del bot (mensual)
      const pago = nextDueDate(f.pago_vence);
      if (pago) {
        const icon = pago.dias <= 2 ? "🔴" : pago.dias <= 5 ? "🟡" : pago.dias <= 7 ? "🟠" : "🟢";
        msg += `   ${icon} Pago del bot: vence en *${pago.dias} día(s)* (${pago.date})\n`;
      }
      msg += "\n";
    }
    if (!(fuentes || []).length) msg += "_No tienes fuentes (bots) configuradas._\n";
    await tgSend(cfg.tg_token, chatId, msg);
    return;
  }

  let titulo = "", desde = "", hasta = "", per = "";
  if (cmd === "/hoy") { desde = hasta = diaPeru(0); titulo = "📊 *HOY*"; per = `Hoy · ${fFechaCorta(desde)}`; }
  else if (cmd === "/ayer") { desde = hasta = diaPeru(-1); titulo = "📊 *AYER*"; per = `Ayer · ${fFechaCorta(desde)}`; }
  else if (cmd === "/semana") {
    let ref = diaPeru(0);
    const mm = arg.match(/(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?/);
    if (mm) { const yy = mm[3] ? (mm[3].length === 2 ? "20" + mm[3] : mm[3]) : diaPeru(0).slice(0, 4); ref = `${yy}-${mm[2].padStart(2, "0")}-${mm[1].padStart(2, "0")}`; }
    desde = lunesDe(ref);
    const dom = new Date(desde + "T12:00:00Z"); dom.setUTCDate(dom.getUTCDate() + 6);
    hasta = dom.toISOString().slice(0, 10); if (hasta > diaPeru(0)) hasta = diaPeru(0);
    titulo = "📊 *SEMANA*"; per = `${fFechaCorta(desde)} → ${fFechaCorta(hasta)}`;
  }
  else if (cmd === "/mes") {
    let y = +diaPeru(0).slice(0, 4), mo = +diaPeru(0).slice(5, 7);
    if (arg) {
      const meses = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
      const byName = meses.findIndex((n) => arg.toLowerCase().startsWith(n.slice(0, 4)));
      const mm = arg.match(/(\d{1,2})(?:[\/-](\d{2,4}))?/);
      if (byName >= 0) mo = byName + 1;
      else if (mm) { mo = +mm[1]; if (mm[2]) y = mm[2].length === 2 ? 2000 + +mm[2] : +mm[2]; }
    }
    if (mo < 1 || mo > 12) mo = +diaPeru(0).slice(5, 7);
    const m2 = String(mo).padStart(2, "0");
    const lastDay = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    desde = `${y}-${m2}-01`; hasta = `${y}-${m2}-${String(lastDay).padStart(2, "0")}`;
    if (hasta > diaPeru(0)) hasta = diaPeru(0);
    titulo = "📊 *MES*"; per = `${fFechaCorta(desde)} → ${fFechaCorta(hasta)}`;
  }
  else if (cmd === "/año" || cmd === "/anio") { desde = diaPeru(0).slice(0, 4) + "-01-01"; hasta = diaPeru(0); titulo = "📊 *AÑO*"; per = `${fFechaCorta(desde)} → ${fFechaCorta(hasta)}`; }
  else if (cmd === "/dia") {
    const mm = arg.match(/(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?/);
    if (!mm) { await tgSend(cfg.tg_token, chatId, "Formato: /dia DD/MM (año actual) o /dia DD/MM/AAAA\nEj: /dia 03/06 · /dia 03/06/2025"); return; }
    const yy = mm[3] ? (mm[3].length === 2 ? "20" + mm[3] : mm[3]) : diaPeru(0).slice(0, 4);
    desde = hasta = `${yy}-${mm[2].padStart(2, "0")}-${mm[1].padStart(2, "0")}`;
    titulo = "📊 *DÍA*"; per = fFechaCorta(desde);
  } else if (cmd === "/pendientes") { await tgSend(cfg.tg_token, chatId, await cmdPendientes(userId), reportKb()); return; }
  else if (cmd === "/mejores") { await tgSend(cfg.tg_token, chatId, await cmdMejores(userId, diaPeru(-7), diaPeru(0)), reportKb()); return; }
  else if (cmd === "/producto" || cmd === "/bot") {
    if (!arg) { await tgSend(cfg.tg_token, chatId, `Usa: ${cmd} <nombre>`); return; }
    desde = lunesDe(diaPeru(0)); hasta = diaPeru(0);
    const data = await reportData(userId, desde, hasta);
    const q = arg.toLowerCase();
    const filtrado = cmd === "/producto"
      ? data.perWs.filter((w: any) => (w.ws.nombre || "").toLowerCase().includes(q))
      : data.perWs.filter((w: any) => (data.fuenteName[w.ws.fuente_id] || "").toLowerCase().includes(q));
    if (!filtrado.length) { await tgSend(cfg.tg_token, chatId, `No encontré "${arg}".`); return; }
    const estPB = await tokenStatusLine(userId).catch(() => "");
    await tgSend(cfg.tg_token, chatId, formatReport(`📊 *${cmd === "/producto" ? "PRODUCTO" : "BOT"}: ${arg}*`, `${fFechaCorta(desde)} → ${fFechaCorta(hasta)}`, { perWs: filtrado, fuenteName: data.fuenteName }) + estPB, reportKb());
    return;
  } else { await tgSend(cfg.tg_token, chatId, AYUDA); return; }

  const data = await reportData(userId, desde, hasta);
  const est = await tokenStatusLine(userId).catch(() => "");
  await tgSend(cfg.tg_token, chatId, formatReport(titulo, per, data) + est, reportKb());
}

// Webhook de Telegram (mensajes + botones)
async function handleTelegram(userId: string, update: any) {
  const cfgs = await sb("GET", `sync_config?user_id=eq.${userId}&limit=1`);
  const cfg = cfgs?.[0];
  if (!cfg || !cfg.tg_token) return json({ ok: true });

  // Botón presionado (callback_query)
  if (update.callback_query) {
    const cq = update.callback_query;
    const chatId = String(cq.message?.chat?.id || cfg.tg_chat_id);
    await fetch(`https://api.telegram.org/bot${cfg.tg_token}/answerCallbackQuery`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: cq.id }),
    }).catch(() => {});
    await tgRunCommand(userId, cfg, chatId, "/" + (cq.data || ""), "");
    return json({ ok: true });
  }

  const m = update.message || update.edited_message;
  if (!m || !m.text) return json({ ok: true });
  const chatId = String(m.chat.id);
  const parts = m.text.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase().replace(/@.*/, "");
  const arg = parts.slice(1).join(" ");

  // /start → vincular este chat
  if (cmd === "/start") {
    await sb("PATCH", `sync_config?user_id=eq.${userId}`, { tg_chat_id: chatId }, "return=minimal").catch(() => {});
    await tgSend(cfg.tg_token, chatId, "✅ *Conectado a Tracker Pro*\n\n" + AYUDA, reportKb());
    return json({ ok: true });
  }
  await tgRunCommand(userId, cfg, chatId, cmd, arg);
  return json({ ok: true });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);

  const url = new URL(req.url);
  const tgUser = url.searchParams.get("tg");
  const rawBody = await req.text();
  let body: any = {};
  try { body = rawBody ? JSON.parse(rawBody) : {}; } catch { body = {}; }

  // Modo programado: aceptar la señal desde el body, un header o el query param.
  // La UI de Cron de Supabase a veces solo deja poner headers, no body — por eso
  // somos tolerantes. Sin esto, una llamada sin "scheduled" caería al sync manual
  // de 90 días para TODOS los usuarios (carísimo si corre cada 15 min).
  const isScheduled =
    body.scheduled === true ||
    String(req.headers.get("x-scheduled") || "").toLowerCase() === "true" ||
    String(req.headers.get("scheduled") || "").toLowerCase() === "true" ||
    String(url.searchParams.get("scheduled") || "").toLowerCase() === "true";

  // Webhook de Telegram (identificado por ?tg=<userId>)
  // IMPORTANTE: responder 200 de inmediato y procesar en segundo plano.
  // Si se hace el sync con await antes de responder, tarda >60s, Telegram cree
  // que falló y reintenta el mismo update sin parar (el loop de /sync).
  if (tgUser && (body.update_id || body.message || body.callback_query)) {
    const work = handleTelegram(tgUser, body).catch((e) => console.error("tg", e));
    try { (globalThis as any).EdgeRuntime?.waitUntil?.(work); }
    catch (_) { /* sin waitUntil: el runtime mantiene la promesa viva igual */ }
    return json({ ok: true });
  }

  // ── Ping de diagnóstico (sin auth): confirma versión + presencia de claves ──
  // Solo devuelve booleanos, nunca el valor de las claves.
  if (body.ping) {
    return json({
      ok: true, version: FN_VERSION,
      hasServiceKey: !!SERVICE_KEY,
      hasAutosyncSecret: !!AUTOSYNC_SECRET,
      supabaseUrl: !!SUPABASE_URL,
    });
  }

  // ── Modo programado (cron cada 15 min) — NO exige el secreto compartido ──
  // runScheduled es idempotente y solo hace trabajo real a las horas configuradas
  // (marca ultima_noche/ultima_manana). No expone datos: solo dispara TU propia
  // sincronización. Por eso lo dejamos antes del control de auth, así el cron de
  // Supabase funciona sin tener que configurarle headers de autenticación.
  if (isScheduled) {
    try { return await runScheduled(); }
    catch (e) { return json({ error: String((e as Error)?.message || e), version: FN_VERSION }, 500); }
  }

  // ── Path A: JWT del usuario (botón "Forzar sync" desde la app) ──
  // El usuario solo puede disparar su propio sync — verificamos la identidad con Supabase Auth.
  const authHeader = req.headers.get("Authorization") || "";
  const userJwt = authHeader.replace(/^Bearer\s+/i, "").trim();
  // Es JWT de usuario si tiene 3 segmentos (header.payload.firma) y no es la service key.
  const looksLikeJwt = userJwt.split(".").length === 3 && userJwt !== SERVICE_KEY;
  if (looksLikeJwt && !isScheduled) {
    let userRes: Response;
    try {
      userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${userJwt}` },
      });
    } catch (e) {
      return json({ error: "No se pudo validar el token con Supabase Auth: " + String((e as Error)?.message || e), version: FN_VERSION }, 502);
    }
    if (!userRes.ok) {
      const txt = await userRes.text().catch(() => "");
      // Token expirado u otra causa — devolvemos el motivo real, no un 401 genérico.
      return json({ error: `Token de usuario rechazado por Auth (${userRes.status}). Cierra sesión y vuelve a entrar. ${txt.slice(0, 200)}`, version: FN_VERSION }, 401);
    }
    const user = await userRes.json().catch(() => null);
    if (!user?.id) return json({ error: "El token es válido pero no trae user.id", version: FN_VERSION }, 401);
    try {
      const conMeta   = body.meta !== false;
      const sheetDays = typeof body.days === "number" ? body.days : 5;
      const r = await procesarUsuario(user.id, conMeta, sheetDays);
      return json({ ok: true, version: FN_VERSION, ...r });
    } catch (e) {
      return json({ error: String((e as Error)?.message || e), version: FN_VERSION }, 500);
    }
  }

  // ── Path B: secreto compartido (cron) o service role ──
  const secret = req.headers.get("x-autosync-secret") || "";
  if (AUTOSYNC_SECRET && secret !== AUTOSYNC_SECRET && userJwt !== SERVICE_KEY)
    return json({ error: "No autorizado (sin secreto válido ni JWT de usuario)", version: FN_VERSION }, 401);

  try {
    // (El modo programado ya se resolvió arriba, antes del control de auth.)
    // Modo manual / directo con service role o secreto
    const conMeta   = body.meta !== false;
    const sheetDays = typeof body.days === "number" ? body.days : 90;
    let userIds: string[];
    if (body.user_id) userIds = [body.user_id];
    else {
      const fs = await sb("GET", "fuentes?select=user_id");
      userIds = [...new Set((fs || []).map((f: any) => f.user_id))];
    }
    const resumen: any[] = [];
    for (const userId of userIds) resumen.push(await procesarUsuario(userId, conMeta, sheetDays));
    return json({ ok: true, procesados: resumen.length, resumen });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
