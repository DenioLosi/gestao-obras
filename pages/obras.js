import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/router";
import { supabase } from "../lib/supabase";

export default function ObrasPage() {
  const router = useRouter();

  const [userEmail, setUserEmail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [projects, setProjects] = useState([]);
  const [unitsByProject, setUnitsByProject] = useState({});
  const [error, setError] = useState(null);

  // helper pra ordenar unidades como número quando possível
  const sortUnitIdentifier = (a, b) => {
    const na = Number(a.identifier);
    const nb = Number(b.identifier);
    const aIsNum = Number.isFinite(na);
    const bIsNum = Number.isFinite(nb);

    if (aIsNum && bIsNum) return na - nb;
    if (aIsNum && !bIsNum) return -1;
    if (!aIsNum && bIsNum) return 1;
    return String(a.identifier).localeCompare(String(b.identifier));
  };

  useEffect(() => {
    async function load() {
      setLoading(true);
      setError(null);

      // 1) garantir que está logado
      const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
      if (sessionError) {
        setError(sessionError.message);
        setLoading(false);
        return;
      }

      const session = sessionData?.session;
      if (!session) {
        router.replace("/login");
        return;
      }

      setUserEmail(session.user?.email ?? "usuário");

      // 2) buscar obras
      const { data: projectsData, error: projectsError } = await supabase
        .from("projects")
        .select("id, name, description, created_at")
        .order("created_at", { ascending: false });

      if (projectsError) {
        setError(projectsError.message);
        setLoading(false);
        return;
      }

      setProjects(projectsData || []);

      // 3) buscar unidades de todas as obras (sem filtrar progress/status!)
      const projectIds = (projectsData || []).map((p) => p.id);

      if (projectIds.length === 0) {
        setUnitsByProject({});
        setLoading(false);
        return;
      }

      const { data: unitsData, error: unitsError } = await supabase
        .from("units")
        .select("id, project_id, identifier, type, status, progress, created_at")
        .in("project_id", projectIds);

      if (unitsError) {
        setError(unitsError.message);
        setLoading(false);
        return;
      }

      // 4) agrupar por obra
      const grouped = {};
      for (const u of unitsData || []) {
        if (!grouped[u.project_id]) grouped[u.project_id] = [];
        grouped[u.project_id].push(u);
      }

      // ordenar unidades dentro de cada obra
      for (const pid of Object.keys(grouped)) {
        grouped[pid].sort(sortUnitIdentifier);
      }

      setUnitsByProject(grouped);
      setLoading(false);
    }

    load();
  }, [router]);

  const hasProjects = projects.length > 0;

  return (
    <div style={{ padding: 24, fontFamily: "Arial, sans-serif" }}>
      <h1 style={{ marginBottom: 8 }}>Obras</h1>

      {userEmail && (
        <p style={{ marginTop: 0, color: "#444" }}>
          Usuário logado: <b>{userEmail}</b>
        </p>
      )}

      {loading && <p>Carregando…</p>}

      {!loading && error && (
        <div style={{ padding: 12, border: "1px solid #f5c2c7", background: "#f8d7da", color: "#842029" }}>
          <b>Erro:</b> {error}
        </div>
      )}

      {!loading && !error && !hasProjects && <p>Nenhuma obra encontrada.</p>}

      {!loading && !error && hasProjects && (
        <div style={{ display: "grid", gap: 16, maxWidth: 720 }}>
          {projects.map((p) => {
            const units = unitsByProject[p.id] || [];

            return (
              <div
                key={p.id}
                style={{
                  border: "1px solid #ddd",
                  borderRadius: 10,
                  padding: 16,
                  background: "white",
                  boxShadow: "0 6px 18px rgba(0,0,0,0.06)",
                }}
              >
                <h2 style={{ margin: "0 0 6px 0" }}>{p.name}</h2>

                {p.description ? (
                  <p style={{ margin: "0 0 12px 0", color: "#555" }}>{p.description}</p>
                ) : (
                  <p style={{ margin: "0 0 12px 0", color: "#777" }}>
                    <i>Sem descrição</i>
                  </p>
                )}

                <div style={{ marginTop: 8 }}>
                  <b>Unidades ({units.length})</b>
                </div>

                {units.length === 0 ? (
                  <p style={{ margin: "8px 0 0 0", color: "#777" }}>
                    Nenhuma unidade cadastrada para esta obra.
                  </p>
                ) : (
                  <ul style={{ margin: "10px 0 0 0", paddingLeft: 18 }}>
                    {units.map((u) => {
                      const prog = Number(u.progress || 0);
                      const started = prog > 0 || u.status !== "pending";

                      return (
                        <li key={u.id} style={{ marginBottom: 6 }}>
                          <span style={{ fontWeight: 700 }}>{u.identifier}</span>{" "}
                          <span style={{ color: "#666" }}>
                            — status: {u.status || "pending"}
                            {typeof u.progress !== "undefined" && u.progress !== null ? ` — progresso: ${prog}%` : ""}
                          </span>
                          {started ? <span style={{ marginLeft: 8 }}>✅</span> : <span style={{ marginLeft: 8 }}>⏳</span>}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
