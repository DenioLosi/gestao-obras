import { useEffect, useState } from "react"
import { useRouter } from "next/router"
import { supabase } from "../lib/supabase"

export default function Obras() {
  const router = useRouter()
  const [loading, setLoading] = useState(true)
  const [user, setUser] = useState(null)
  const [projects, setProjects] = useState([])

  useEffect(() => {
    const init = async () => {
      const { data } = await supabase.auth.getSession()

      if (!data.session) {
        router.push("/login")
        return
      }

      setUser(data.session.user)

      const { data: projectsData, error } = await supabase
        .from("projects")
        .select("*")
        .order("created_at", { ascending: false })

      if (!error) {
        setProjects(projectsData)
      }

      setLoading(false)
    }

    init()
  }, [])

  if (loading) return <p style={{ padding: 24 }}>Carregando...</p>

  return (
    <div style={{ padding: 24 }}>
      <h1>Obras</h1>
      <p>Usuário logado: {user.email}</p>

      <hr style={{ margin: "20px 0" }} />

      {projects.length === 0 && <p>Nenhuma obra encontrada.</p>}

      {projects.map((project) => (
        <div
          key={project.id}
          style={{
            padding: 16,
            marginBottom: 12,
            border: "1px solid #ddd",
            borderRadius: 8
          }}
        >
          <strong>{project.name}</strong>
          <p>{project.description}</p>
        </div>
      ))}
    </div>
  )
}
