import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/router";
import Link from "next/link";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  }
);

export default function UnidadeDetalhePage() {
  const router = useRouter();
  const { id } = router.query;

  const [loading, setLoading] = useState(true);
  const [unit, setUnit] = useState(null);
  const [unitStages, setUnitStages] = useState([]);
  const [savingStageId, setSavingStageId] = useState(null);

  const unitId = useMemo(() => {
    if (!id) return null;
    if (Array.isArray(id)) return id[0] || null;
    return String(id);
  }, [id]);

  const unitTitle = useMemo(() => {
    if (!unit) return "Unidade";
    const label = unit.identifier ?? unit.id?.slice(0, 8);
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
    if (!router.isReady) return;
    if (!unitId) return;

    setLoading(true);

    const ok = await requireAuth();
    if (!ok) return;

    // ✅ unidade: agora traz identifier
    const unitRes = await supabase
      .from("units")
      .select("id, project_id, identifier")
      .eq("id", unitId)
      .maybeSingle();

    if (unitRes.error) {
      console.error("Erro unitRes:", unitRes.error);
      alert(`Erro ao carregar unidade: ${unitRes.error.message}`);
      setLoading(false);
      return;
    }

    if (!unitRes.data) {
      setUnit(null);
      setUnitStages([]);
      setLoading(false);
      return;
    }

    // ✅ etapas (sem progress por enquanto)
    const stagesRes = await supabase
      .from("unit_stages")
      .select("id, unit_id, stage_id, status, notes, stages(id, name, order_index)")
      .eq("unit_id", unitId);

    if (stagesRes.error) {
      console.error("Erro stagesRes:", stagesRes.error);
      alert(`Erro ao carregar etapas: ${stagesRes.error.message}`);
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
  }, [router.isReady, unitId]);

  async function updateStage(unitStageId, patch) {
    setSavingStageId(unitStageId);

    const upd = await supabase.from("unit_stages").update(patch).eq("id", unitStageId);
    if (upd.error) {
      console.error("Erro upd:", upd.error);
      alert(`Erro ao salvar etapa: ${upd.error.message}`);
      setSavingStageId(null);
      return;
    }

    setUnitStages((prev) =>
      prev.map((r) => (r.id === unitStageId ? { ...r, ...patch } : r))
    );

    setSavingStageId(null);
  }

  async function setStageStatus(row, targetStatus) {
    await updateStage(row.id, { status: targetStatus });
  }

  async function saveNotes(row, notes) {
    await updateStage(row.id, { notes: notes ?? "" });
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
            project_id: {unit.project_id ?? "-"} • identifier: {unit.identifier ?? "-"}
          </div>

          <h1 style={{ margin: "6px 0" }}>{unitTitle}</h1>
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
          const disabled = savingStageId === row.id;

          return (
            <div key={row.id} style={{ border: "1px solid #e5e5e5", borderRadius: 12, padding: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
                <div>
                  <div style={{ fontWeight: 600 }}>{stageName}</div>
                  <div style={{ fontSize: 12, opacity: 0.75 }}>
                    Status: {row.status || "—"}
                  </div>
                </div>

                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button disabled={disabled} onClick={() => setStageStatus(row, "pending")}>
                    Pendente
                  </button>
                  <button disabled={disabled} onClick={() => setStageStatus(row, "in_progress")}>
                    Em andamento
                  </button>
                  <button disabled={disabled} onClick={() => setStageStatus(row, "done")}>
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
                <div style={{ fontSize: 12, opacity: 0.6, marginTop: 6 }}>(Salva ao sair do campo)</div>
              </div>

              {disabled && <div style={{ marginTop: 8, fontSize: 12, opacity: 0.7 }}>Salvando…</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
