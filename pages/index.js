export default function Home() {
  return (
    <div style={styles.container}>
      <h1 style={styles.title}>Gestão de Obras</h1>
      <p style={styles.subtitle}>
        Sistema de acompanhamento de obras, etapas, pendências e estoque.
      </p>

      <div style={styles.card}>
        <h2>MVP em construção 🚀</h2>
        <p>Backend conectado ao Supabase.</p>
        <p>Frontend rodando com Next.js.</p>
      </div>
    </div>
  );
}

const styles = {
  container: {
    minHeight: "100vh",
    backgroundColor: "#f5f7fa",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    fontFamily: "Arial, sans-serif",
    padding: "20px",
  },
  title: {
    fontSize: "32px",
    fontWeight: "bold",
    marginBottom: "10px",
  },
  subtitle: {
    fontSize: "16px",
    marginBottom: "30px",
    color: "#555",
    textAlign: "center",
  },
  card: {
    backgroundColor: "#ffffff",
    padding: "30px",
    borderRadius: "12px",
    boxShadow: "0 10px 25px rgba(0,0,0,0.1)",
    textAlign: "center",
    maxWidth: "400px",
  },
};
