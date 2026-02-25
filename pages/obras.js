import { useEffect, useState } from "react"
import { useRouter } from "next/router"
import { supabase } from "../lib/supabase"

export default function Obras() {
  const router = useRouter()
  const [loading, setLoading] = useState(true)
  const [user, setUser] = useState(null)
  const [projects, setProjects] = useState([])
  const [errorMessage, setErrorMessage] = useState("")

  useEffect(() => {
    const init = async () => {
      const { data: sessionData } = await supabase.auth.getSession()

      if (!sessionData.session) {
        router.push("/login")
        return
      }

      setUser(sessionData.session.user)

      const { data, error } = await supabase
        .from("projects")
        .select("*")
        .order("created_at", { ascending: false })

      if (error) {
        console.error("Erro ao buscar obras:", error)
        setErrorMessage(error.message)
      } else {
        setProjects(data || [])
      }

      setLoading(false)
    }

    init()
  }, [])

  if (loading) {
    return <div style={{ padding: 24 }}>Carregando...</div>
  }

  return (
    <div style={{ padding: 24, fontFamily: "Arial" }}>
      <h1>Obras</h1>

      <p><strong>Usuário logado:</strong> {user?.email}</p>

      <hr style={{ margin: "20px 0" }} />

      {errorMessage && (
        <div style={{ color: "red", marginBottom: 20 }}>
          <strong>Erro:</strong> {errorMessage}
        </div>
      )}

      {projects.length === 0 && !errorMessage && (
        <p>Nenhuma obra encontrada.</p>
      )}

      {projects.map((project) => (
        <div
          key={project.id}
          style={{
            padding: 16,
            marginBottom: 12,
            border: "1px solid #ddd",
            borderRadius: 8,
            background: "#fff"
          }}
        >
          <strong>{project.name}</strong>
          <p>{project.description}</p>
        </div>
      ))}
    </div>
  )
}
