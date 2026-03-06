import { useState } from "react"
import { supabase } from "../lib/supabase"

export default function AlterarSenha() {

  const [senha, setSenha] = useState("")
  const [loading, setLoading] = useState(false)

  async function salvar() {

    if (!senha || senha.length < 6) {
      alert("Senha deve ter no mínimo 6 caracteres")
      return
    }

    setLoading(true)

    const { error } = await supabase.auth.updateUser({
      password: senha
    })

    if (error) {
      alert(error.message)
      setLoading(false)
      return
    }

    const { data } = await supabase.auth.getUser()

    await supabase
      .from("profiles")
      .update({ must_change_password: false })
      .eq("id", data.user.id)

    alert("Senha alterada com sucesso!")

    window.location.href = "/"

  }

  return (

    <div style={{
      minHeight:"100vh",
      display:"flex",
      justifyContent:"center",
      alignItems:"center",
      fontFamily:"Arial",
      background:"#f5f7fa"
    }}>

      <div style={{
        background:"#fff",
        padding:30,
        borderRadius:12,
        border:"1px solid #eee",
        width:350
      }}>

        <h2>Alterar senha</h2>

        <p>
        Primeiro acesso detectado.  
        Defina uma nova senha.
        </p>

        <input
          type="password"
          placeholder="Nova senha"
          value={senha}
          onChange={(e)=>setSenha(e.target.value)}
          style={{
            width:"100%",
            padding:10,
            borderRadius:8,
            border:"1px solid #ccc",
            marginTop:10
          }}
        />

        <button
          onClick={salvar}
          disabled={loading}
          style={{
            marginTop:15,
            width:"100%",
            padding:10,
            borderRadius:8,
            border:"none",
            background:"#111",
            color:"#fff",
            fontWeight:"bold",
            cursor:"pointer"
          }}
        >
          Salvar nova senha
        </button>

      </div>

    </div>

  )
}
