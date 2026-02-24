import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { useRouter } from "next/router";

export default function Login() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [msg, setMsg] = useState("");

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data?.session) router.replace("/obras");
    });
  }, [router]);

  async function handleLogin(e) {
    e.preventDefault();
    setMsg("Enviando link...");
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}/obras` }
    });

    if (error) setMsg("Erro: " + error.message);
    else setMsg("Link enviado para seu e-mail.");
  }

  return (
    <div style={{ maxWidth: 420, margin: "100px auto", background: "#fff", padding: 24, borderRadius: 12 }}>
      <h2>Entrar</h2>
      <p style={{ color: "#666" }}>Login por link no e-mail</p>

      <form onSubmit={handleLogin}>
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="seuemail@..."
          style={{ width: "100%", padding: 12, marginTop: 8, borderRadius: 8, border: "1px solid #ddd" }}
        />

        <button
          style={{ width: "100%", marginTop: 12, padding: 12, borderRadius: 8, border: 0, cursor: "pointer" }}
        >
          Enviar link
        </button>
      </form>

      {msg ? <p style={{ marginTop: 12 }}>{msg}</p> : null}
    </div>
  );
}
