// Edge Function: admin-users
// Maneja operaciones de auth que requieren service_role SIN exponer la clave en el cliente.
// La service key vive como secreto del entorno (SUPABASE_SERVICE_ROLE_KEY), nunca en el navegador.
//
// Acciones (POST { action, ... }):
//   - "create"      → crea un usuario (solo admin)        { email, password }
//   - "delete"      → borra otro usuario y sus datos (solo admin) { userId }
//   - "delete_self" → el usuario borra su propia cuenta    {}
//
// El llamante se identifica por su JWT (header Authorization: Bearer <token>).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
// Prefiere la secret key nueva (sb_secret_...) guardada como secreto de la función;
// si no está, cae a la service_role inyectada por la plataforma.
const SERVICE_KEY = Deno.env.get("ADMIN_SERVICE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

// Tablas con columna user_id (limpieza best-effort; workspaces ya cascadea casi todo)
const USER_TABLES = [
  "notas", "notas_campanas", "crm_ventas", "sync_log", "registros",
  "conjuntos", "anuncios", "campanas", "cuentas_pub", "business_managers", "config",
];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);

  try {
    const token = (req.headers.get("Authorization") || "").replace("Bearer ", "").trim();
    if (!token) return json({ error: "No autorizado" }, 401);

    // Cliente con service_role (bypassa RLS). La clave nunca sale del servidor.
    const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

    // Identificar al llamante a partir de su propio JWT
    const { data: userData, error: userErr } = await admin.auth.getUser(token);
    if (userErr || !userData?.user) return json({ error: "Sesión inválida" }, 401);
    const caller = userData.user;

    // ¿El llamante es admin? (misma fuente de verdad que el frontend: profiles.is_admin)
    const { data: prof } = await admin
      .from("profiles").select("is_admin").eq("id", caller.id).single();
    const isAdmin = prof?.is_admin === true;

    const body = await req.json().catch(() => ({}));
    const action = body.action;

    // ── Crear usuario (solo admin) ──
    if (action === "create") {
      if (!isAdmin) return json({ error: "Solo administradores" }, 403);
      const { email, password } = body;
      if (!email || !email.includes("@")) return json({ error: "Email inválido" }, 400);
      if (!password || password.length < 6) return json({ error: "Contraseña mínima 6 caracteres" }, 400);
      const { data, error } = await admin.auth.admin.createUser({
        email, password, email_confirm: true,
      });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true, user: { id: data.user?.id, email: data.user?.email } });
    }

    // ── Borrar usuario (admin a otro, o el propio usuario a sí mismo) ──
    if (action === "delete" || action === "delete_self") {
      let userId: string;
      if (action === "delete") {
        if (!isAdmin) return json({ error: "Solo administradores" }, 403);
        userId = body.userId;
        if (!userId) return json({ error: "Falta userId" }, 400);
        if (userId === caller.id) return json({ error: "Usa delete_self para tu propia cuenta" }, 400);
      } else {
        userId = caller.id; // delete_self: solo puede borrarse a sí mismo
      }

      // Borrar datos: workspaces cascadea la mayoría; el resto best-effort por user_id
      await admin.from("workspaces").delete().eq("user_id", userId);
      for (const t of USER_TABLES) {
        try { await admin.from(t).delete().eq("user_id", userId); } catch (_) { /* ignore */ }
      }
      await admin.from("profiles").delete().eq("id", userId);

      // Borrar el usuario de auth
      const { error } = await admin.auth.admin.deleteUser(userId);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    return json({ error: "Acción desconocida" }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
