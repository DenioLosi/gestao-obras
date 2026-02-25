import { useEffect, useState } from "react"
import { useRouter } from "next/router"
import { supabase } from "../lib/supabase"

export default function Obras() {
  const router = useRouter()
  const [loading, setLoading] = useState(true)
  const [user, setUser] = useState(null)

  useEffect(() => {
    const checkUser = async () => {
      const { data } = await supabase.auth.getSession()

      if (!data.session) {
        router.push("/login")
      } else {
        setUser(data.session.user)
        setLoading(false)
      }
    }

    checkUser()
  }, [])

  if (loading) return <p style={{ padding: 24 }}>Carregando...</p>

  return (
    <div style={{ padding: 24 }}>
      <h1>Obras</h1>
      <p>Usuário logado: {user.email}</p>
      <p>Painel em construção 🚀</p>
    </div>
  )
}
