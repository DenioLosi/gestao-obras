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

    const { data: userData, error: userError } = await supabase.auth.getUser()

    if (userError) {
      alert(userError.message)
      setLoading(false)
      return
    }

    const userId = userData?.user?.id

    if (!userId) {
      alert("Não foi possível identificar o usuário autenticado.")
      setLoading(false)
      return
    }

    const { data: updatedProfile, error: profileError } = await supabase
      .from("profiles")
      .update({ must_change_password: false })
      .eq("id", userId)
      .select("id, must_change_password")
      .maybeSingle()

    if (profileError) {
      alert(profileError.message)
      setLoading(false)
      return
    }

    if (!updatedProfile) {
      alert("NÃ£o foi possÃ­vel concluir o primeiro acesso no perfil do usuÃ¡rio.")
      setLoading(false)
      return
    }

    const { data: confirmedProfile, error: confirmError } = await supabase
      .from("profiles")
      .select("id, must_change_password")
      .eq("id", userId)
      .maybeSingle()

    if (confirmError) {
      alert(confirmError.message)
      setLoading(false)
      return
    }

    if (!confirmedProfile || confirmedProfile.must_change_password) {
      alert("A troca de senha foi salva, mas o primeiro acesso ainda nÃ£o foi concluÃ­do.")
      setLoading(false)
      return
    }

    alert("Senha alterada com sucesso!")

    window.location.replace("/")
    setLoading(false)
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
