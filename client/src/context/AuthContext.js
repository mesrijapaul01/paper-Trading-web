import React, { createContext, useContext, useEffect, useState } from "react";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [token, setToken] = useState(localStorage.getItem("token"));
  const [email, setEmail] = useState(localStorage.getItem("userEmail"));

  // Keeps state in sync if the user logs out/in from another tab.
  useEffect(() => {
    const handleStorageChange = () => {
      setToken(localStorage.getItem("token"));
      setEmail(localStorage.getItem("userEmail"));
    };
    window.addEventListener("storage", handleStorageChange);
    return () => window.removeEventListener("storage", handleStorageChange);
  }, []);

  // Called directly from Login.js after a successful login.
  // Updates React state immediately, in the SAME tab — this is what the
  // original code was missing, since the browser "storage" event never
  // fires in the tab that made the change.
  const login = (newToken, newEmail) => {
    localStorage.setItem("token", newToken);
    localStorage.setItem("userEmail", newEmail);
    setToken(newToken);
    setEmail(newEmail);
  };

  const logout = () => {
    localStorage.removeItem("token");
    localStorage.removeItem("userEmail");
    setToken(null);
    setEmail(null);
  };

  return (
    <AuthContext.Provider value={{ token, email, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
