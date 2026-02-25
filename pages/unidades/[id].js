import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/router";
import Link from "next/link";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

function clampProgress(v) {
  const n = Number(v);
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

export default function UnidadeDetalhePage() {
  const router = useRouter();
  const { id } = router.query;

  const [loading, setLoading] = useState(true);
  const [unit, setUnit] = useState(null);
  const [unitStages, setUnitStages] = useState([]);
  const [savingStageId, setSavingStageId] = useState(null);

  const unitTitle = useMemo(() => {
    if (!unit) return "Unidade";
    const label = unit.number ?? unit.name ?? unit.id?.slice(0, 8);
    return `Unidade ${label}`;
  }, [unit]);

  async function requireAuth() {
    const { data } = await supabase.auth.getSession();
    if (!data?.session) {
      router.replace("/login");
      return false;
    }
    return true;
  }

  async function load() {
    if (!id) return;
    setLoading(true);

    const ok = await requireAuth();
    if (!ok) return;

    // 1) Busca unidade + obra (projects)
    const unitRes = await supabase
      .from("units")
      .select("id, number, name, progress, status, project_id, projects(id, name)")
      .eq("id", id)
      .single();

    if (unitRes.error) {
      console.error(unitRes.error);
      alert("Erro ao carregar unidade.");
      setLoading(false);
      return;
    }

    // 2) Busca unit_stages + stages
    const stagesRes = await supabase
      .from("unit_stages")
      .select("id, unit_id, stage_id, progress, status, notes, stages(id, name, order_index)")
      .eq("unit_id", id);

    if (stagesRes.error) {
      console.error(stagesRes.error);
      alert("Erro ao carregar etapas.");
      setLoading(false);
      return;
    }

    const rows = (stagesRes.data || []).slice().sort((a, b) => {
      const ao = a?.stages?.order_index ?? 999999;
      const bo = b?.stages?.order_index ?? 999999;
      if (ao !== bo) return ao - bo;
      const an = (a?.stages?.name || "").toString();
      const bn = (b?.stages?.name || "").toString();
      return an.localeCompare(bn);
    });

    setUnit(unitRes.data);
    setUnitStages(rows);
    setLoading(false);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function updateStage(unitStageId, patch, logAction, oldValue, newValue) {
    setSavingStageId(unitStageId);

    // update em unit_stages
    const upd = await supabase.from("unit_stages").update(patch).eq("id", unitStageId);
    if (upd.error) {
      console.error(upd.error);
      alert("Erro ao salvar etapa.");
      setSavingStageId(null);
      return;
    }

    // cria log
    const { data: sessionData } = await supabase.auth.getSession();
    const userId = sessionData?.session?.user?.id;

    if (userId) {
      const ins = await supabase.from("unit_stage_logs").insert({
        unit_stage_id: unitStageId,
        user_id: userId,
        action: logAction,
        old_value: oldValue ?? null,
        new_value: newValue ?? null,
      });
      if (ins.error) {
        // log não é crítico pro MVP, mas mostramos no console
        console.error("Falha ao inserir log:", ins.error);
      }
    }

    // atualiza UI local
    setUnitStages((prev) =>
      prev.map((r) => (r.id === unitStageId ? { ...r, ...patch } : r))
    );

    // recarrega unidade (pra pegar progress/status recalculado pelos triggers)
    const unitRes = await supabase
      .from("units")
      .select("id, number, name, progress, status, project_id, projects(id, name)")
      .eq("id", id)
      .single();

    if (!unitRes.error) setUnit(unitRes.data);

    setSavingStageId(null);
  }

  async function setStageQuickStatus(row, target) {
    const old = { progress: row.progress ?? 0, status: row.status ?? "pending", notes: row.notes ?? "" };

    let nextProgress = row.progress ?? 0;
    if (target === "pending") nextProgress = 0;
    if (target === "in_progress") nextProgress = Math.max(1, Math.min(99, clampProgress(nextProgress || 50)));
    if (target === "done") nextProgress = 100;

    const patch = { progress: nextProgress };
    const next = { ...old, progress: nextProgress };

    await updateStage(row.id, patch, "progress_changed", old, next);
  }

  async function saveNotes(row, notes) {
    const old = { notes: row.notes ?? "" };
    const patch = { notes: notes ?? "" };
    const next = { notes: notes ?? "" };

    await updateStage(row.id, patch, "note_updated", old, next);
  }

  if (loading) {
    return (
      <div style={{ padding: 16 }}>
        <p>Carregando…</p>
      </div>
    );
  }

  if (!unit) {
    return (
      <div style={{ padding: 16 }}>
        <p>Unidade não encontrada.</p>
        <Link href="/obras">Voltar</Link>
      </div>
    );
  }

  return (
    <div style={{ padding: 16, maxWidth: 1000, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
        <div>
          <div style={{ fontSize: 12, opacity: 0.7 }}>
            Obra: {unit?.projects?.name ?? unit.project_id ?? "-"}
          </div>
          <h1 style={{ margin: "6px 0" }}>{unitTitle}</h1>
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <span style={{ fontSize: 12, padding: "4px 8px", border: "1px solid #ddd", borderRadius: 999 }}>
              Status: {unit.status || "-"}
            </span>
            <span style={{ fontSize: 12, padding: "4px 8px", border: "1px solid #ddd", borderRadius: 999 }}>
              Progresso: {Math.round(unit.progress ?? 0)}%
            </span>
          </div>
        </div>

        <Link href="/obras" style={{ fontSize: 14 }}>
          ← Voltar
        </Link>
      </div>

      <hr style={{ margin: "16px 0" }} />

      <h2 style={{ margin: "0 0 10px" }}>Etapas</h2>

      <div style={{ display: "grid", gap: 12 }}>
        {unitStages.map((row) => {
          const stageName = row?.stages?.name || row.stage_id;
          const p = Math.round(row.progress ?? 0);
          const disabled = savingStageId === row.id;

          return (
            <div key={row.id} style={{ border: "1px solid #e5e5e5", borderRadius: 12, padding: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
                <div>
                  <div style={{ fontWeight: 600 }}>{stageName}</div>
                  <div style={{ fontSize: 12, opacity: 0.75 }}>
                    {row.status || "—"} • {p}%
                  </div>
                </div>

                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button disabled={disabled} onClick={() => setStageQuickStatus(row, "pending")}>
                    Pendente
                  </button>
                  <button disabled={disabled} onClick={() => setStageQuickStatus(row, "in_progress")}>
                    Em andamento
                  </button>
                  <button disabled={disabled} onClick={() => setStageQuickStatus(row, "done")}>
                    Concluído
                  </button>
                </div>
              </div>

              <div style={{ marginTop: 10 }}>
                <div style={{ fontSize: 12, marginBottom: 6, opacity: 0.8 }}>Observações</div>
                <textarea
                  defaultValue={row.notes || ""}
                  placeholder="Escreva observações desta etapa…"
                  rows={3}
                  style={{ width: "100%", padding: 10, borderRadius: 10, border: "1px solid #ddd" }}
                  onBlur={(e) => {
                    const value = e.target.value;
                    if ((value || "") !== (row.notes || "")) saveNotes(row, value);
                  }}
                  disabled={disabled}
                />
                <div style={{ fontSize: 12, opacity: 0.6, marginTop: 6 }}>
                  (Salva ao sair do campo)
                </div>
              </div>

              {disabled && (
                <div style={{ marginTop: 8, fontSize: 12, opacity: 0.7 }}>
                  Salvando…
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
