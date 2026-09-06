import React, { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useAuth } from "./context/AuthContext";

function Login() {
  const [form, setForm] = useState({ email: "", password: "" });
  const [message, setMessage] = useState("");
  const navigate = useNavigate();
  const { login } = useAuth();

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.email || !form.password) {
      setMessage("✗ Please enter both email and password");
      return;
    }
    try {
      const res = await fetch("/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (data.token) {
        login(data.token, data.email); // updates shared auth state right away
        setMessage("✓ Login successful");
        navigate("/dashboard");
      } else {
        setMessage(data.message || "✗ Login failed");
      }
    } catch (err) {
      setMessage("✗ Error: " + err.message);
    }
  };

  return (
    <div className="auth-container">
      <h2>Login</h2>
      <form onSubmit={handleSubmit}>
        <input
          type="email"
          placeholder="Email"
          value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
        />
        <input
          type="password"
          placeholder="Password"
          value={form.password}
          onChange={(e) => setForm({ ...form, password: e.target.value })}
        />
        <button type="submit" className="btn-primary">
          Login
        </button>
      </form>
      {message && (
        <p className={message.startsWith("✓") ? "text-green" : "text-red"} style={{ textAlign: "center" }}>
          {message}
        </p>
      )}
      <p>
        Haven’t registered yet? <Link to="/register">Register here</Link>
      </p>
    </div>
  );
}

export default Login;
